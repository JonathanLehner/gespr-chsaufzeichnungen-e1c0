import "server-only";
import type { AudioMime } from "./audio";
import { mp3Frames, parseWavLayout } from "./audio-split";

/**
 * Lautstärkeverlauf einer Aufnahme.
 *
 * Für die Ausrichtung des Transkripts wird nicht der Ton selbst gebraucht,
 * sondern nur, wann gesprochen wird und wann nicht. Dafür genügt ein
 * Effektivwert je kurzem Rahmen. Der absolute Pegel spielt keine Rolle – die
 * Sprecherkennung arbeitet ausschliesslich mit Perzentilen dieses Verlaufs –,
 * weshalb die Werte lediglich untereinander vergleichbar sein müssen.
 */
export type Envelope = {
  frameMs: number;
  /** Effektivwert je Rahmen. Nur relativ zu den übrigen Werten aussagekräftig. */
  rms: Float32Array;
  durationMs: number;
  source: "wav" | "mp3";
};

export const ENVELOPE_FRAME_MS = 10;

/* --------------------------------------------------------------------- WAV */

/** Liest einen Abtastwert als Zahl zwischen −1 und 1. */
type SampleReader = (view: DataView, byteOffset: number) => number;

const MU_LAW = buildG711((value) => {
  const sign = value & 0x80 ? -1 : 1;
  const magnitude = ~value & 0x7f;
  const exponent = (magnitude >> 4) & 0x07;
  const mantissa = magnitude & 0x0f;
  const sample = ((mantissa << 1) + 33) * (1 << exponent) - 33;
  return (sign * sample) / 8158;
});

const A_LAW = buildG711((value) => {
  const inverted = value ^ 0x55;
  const sign = inverted & 0x80 ? -1 : 1;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const sample = exponent === 0 ? (mantissa << 1) + 1 : ((mantissa << 1) + 33) * (1 << exponent);
  return (sign * sample) / 4032;
});

function buildG711(decode: (value: number) => number): Float32Array {
  const table = new Float32Array(256);
  for (let value = 0; value < 256; value += 1) table[value] = decode(value);
  return table;
}

/**
 * Wählt den Leser für das im Kopf angegebene Format. Telefonanlagen liefern
 * neben linearem PCM auch G.711-komprimierte Dateien; beide Varianten sind hier
 * abgedeckt, weil sonst ausgerechnet die typische Gesprächsaufzeichnung ohne
 * Lautstärkeverlauf bliebe.
 */
function sampleReader(audioFormat: number, bitsPerSample: number): SampleReader | null {
  if (audioFormat === 1) {
    if (bitsPerSample === 8) return (view, at) => view.getUint8(at) / 128 - 1;
    if (bitsPerSample === 16) return (view, at) => view.getInt16(at, true) / 32768;
    if (bitsPerSample === 24) {
      return (view, at) => {
        const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        return raw / 8388608;
      };
    }
    if (bitsPerSample === 32) return (view, at) => view.getInt32(at, true) / 2147483648;
  }
  if (audioFormat === 3) {
    if (bitsPerSample === 32) return (view, at) => view.getFloat32(at, true);
    if (bitsPerSample === 64) return (view, at) => view.getFloat64(at, true);
  }
  if (audioFormat === 6 && bitsPerSample === 8) return (view, at) => A_LAW[view.getUint8(at)];
  if (audioFormat === 7 && bitsPerSample === 8) return (view, at) => MU_LAW[view.getUint8(at)];
  return null;
}

function wavEnvelope(bytes: Uint8Array, frameMs: number): Envelope | null {
  const layout = parseWavLayout(bytes);
  if (!layout || layout.sampleRate <= 0 || layout.channels <= 0 || layout.blockAlign <= 0) {
    return null;
  }
  const read = sampleReader(layout.audioFormat, layout.bitsPerSample);
  if (!read) return null;

  const bytesPerSample = Math.floor(layout.bitsPerSample / 8);
  if (bytesPerSample * layout.channels > layout.blockAlign) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalFrames = Math.floor(layout.dataLength / layout.blockAlign);
  const perWindow = Math.max(1, Math.round((layout.sampleRate * frameMs) / 1000));
  const windows = Math.ceil(totalFrames / perWindow);
  const rms = new Float32Array(windows);

  for (let window = 0; window < windows; window += 1) {
    const from = window * perWindow;
    const to = Math.min(from + perWindow, totalFrames);
    let sum = 0;
    let count = 0;
    for (let frame = from; frame < to; frame += 1) {
      const base = layout.dataOffset + frame * layout.blockAlign;
      for (let channel = 0; channel < layout.channels; channel += 1) {
        const value = read(view, base + channel * bytesPerSample);
        sum += value * value;
        count += 1;
      }
    }
    rms[window] = count > 0 ? Math.sqrt(sum / count) : 0;
  }

  return {
    frameMs,
    rms,
    durationMs: Math.round((totalFrames / layout.sampleRate) * 1000),
    source: "wav",
  };
}

/* --------------------------------------------------------------------- MP3 */

/**
 * Lautstärkeverlauf einer MP3-Datei ohne Decodierung.
 *
 * Jedes Granulat – 576 Abtastwerte – trägt in der Seiteninformation ein Feld
 * `global_gain`: den Skalierungsfaktor, mit dem die quantisierten Spektralwerte
 * zurückgerechnet werden. Er wächst mit der Amplitude des Signals und ist damit
 * genau das, was hier gebraucht wird. Ihn abzulesen kostet ein paar Bit je
 * Granulat, während eine vollständige Decodierung einen Decoder erforderte, den
 * die Laufzeitumgebung nicht zulässt (WebAssembly aus Rohbytes ist im Worker
 * gesperrt).
 *
 * Lage des Feldes, gezählt ab dem ersten Bit der Seiteninformation:
 *  - MPEG 1: `main_data_begin` (9) + `private_bits` (5 mono / 3 stereo) +
 *    `scfsi` (4 je Kanal), danach je Granulat und Kanal ein Block von 59 Bit.
 *  - MPEG 2/2.5: `main_data_begin` (8) + `private_bits` (1 mono / 2 stereo),
 *    danach ein Block von 63 Bit je Kanal – nur ein Granulat je Frame.
 * In beiden Blöcken stehen zuerst `part2_3_length` (12) und `big_values` (9);
 * `global_gain` folgt als 8 Bit an Position 21.
 *
 * `part2_3_length` wird mitgelesen, weil `global_gain` allein bei digitaler
 * Stille in die Irre führt: Ist nichts zu quantisieren, bleibt das Feld auf
 * einem hohen Vorgabewert stehen und eine stumme Stelle sähe lauter aus als
 * eine gesprochene. Ein Granulat ohne Daten ist aber genau daran zu erkennen,
 * dass `part2_3_length` null ist – dann ist es still, unabhängig vom Gain.
 */
const LENGTH_OFFSET_IN_BLOCK = 0;
const GAIN_OFFSET_IN_BLOCK = 21;

function readBits(bytes: Uint8Array, bitPosition: number, count: number): number {
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    const bit = bitPosition + index;
    const byte = bytes[bit >> 3];
    if (byte === undefined) return -1;
    value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
  }
  return value;
}

type GranuleGain = { startMs: number; endMs: number; amplitude: number };

function mp3Gains(bytes: Uint8Array): GranuleGain[] {
  const gains: GranuleGain[] = [];
  let timeMs = 0;

  for (const frame of mp3Frames(bytes)) {
    const sideInfo = (frame.offset + 4 + (frame.hasCrc ? 2 : 0)) * 8;
    const header =
      frame.version === 3
        ? 9 + (frame.channels === 1 ? 5 : 3) + 4 * frame.channels
        : 8 + (frame.channels === 1 ? 1 : 2);
    const blockBits = frame.version === 3 ? 59 : 63;
    const granuleMs = frame.durationMs / frame.granules;

    for (let granule = 0; granule < frame.granules; granule += 1) {
      let sum = 0;
      let read = 0;
      for (let channel = 0; channel < frame.channels; channel += 1) {
        const block = sideInfo + header + (granule * frame.channels + channel) * blockBits;
        const length = readBits(bytes, block + LENGTH_OFFSET_IN_BLOCK, 12);
        const gain = readBits(bytes, block + GAIN_OFFSET_IN_BLOCK, 8);
        if (length < 0 || gain < 0) continue;
        // Die Skala ist logarithmisch: vier Schritte entsprechen einer
        // Verdopplung der Amplitude.
        sum += length === 0 ? 0 : Math.pow(2, (gain - 210) / 4);
        read += 1;
      }
      if (read > 0) {
        gains.push({
          startMs: timeMs,
          endMs: timeMs + granuleMs,
          amplitude: sum / read,
        });
      }
      timeMs += granuleMs;
    }
  }
  return gains;
}

function mp3Envelope(bytes: Uint8Array, frameMs: number): Envelope | null {
  const gains = mp3Gains(bytes);
  if (gains.length < 8) return null;

  // Bezugsgrösse ist nicht der höchste Wert, sondern das 99. Perzentil: Ein
  // einzelnes Granulat mit ungewöhnlich hohem Gain drückte sonst den ganzen
  // übrigen Verlauf gegen null.
  const sorted = [...gains].map((gain) => gain.amplitude).sort((a, b) => a - b);
  const peak = sorted[Math.floor(0.99 * (sorted.length - 1))];
  const floor = sorted[Math.floor(0.05 * (sorted.length - 1))];
  // Ein Verlauf ohne Dynamik trägt keine Information über Sprechpausen. Das
  // deutet auf eine falsch gelesene Seiteninformation hin – dann lieber gar
  // kein Verlauf als ein irreführender.
  if (!Number.isFinite(peak) || peak <= 0 || peak / Math.max(floor, peak / 1e6) < 4) return null;

  const durationMs = gains[gains.length - 1].endMs;
  const windows = Math.max(1, Math.ceil(durationMs / frameMs));
  const rms = new Float32Array(windows);
  let cursor = 0;
  for (let window = 0; window < windows; window += 1) {
    const at = window * frameMs + frameMs / 2;
    while (cursor + 1 < gains.length && gains[cursor].endMs <= at) cursor += 1;
    rms[window] = Math.min(1, gains[cursor].amplitude / peak);
  }

  return { frameMs, rms, durationMs: Math.round(durationMs), source: "mp3" };
}

/* ------------------------------------------------------------------ Fassade */

/**
 * Ermittelt den Lautstärkeverlauf einer Aufnahme. Gibt `null` zurück, wenn das
 * Format nicht gelesen werden kann; die Wortzeiten werden dann rein sprachlich
 * geschätzt statt akustisch ausgerichtet.
 */
export function energyEnvelope(
  bytes: Uint8Array,
  mime: AudioMime,
  frameMs: number = ENVELOPE_FRAME_MS,
): Envelope | null {
  try {
    const envelope = mime === "audio/wav" ? wavEnvelope(bytes, frameMs) : mp3Envelope(bytes, frameMs);
    return envelope && envelope.rms.length > 0 ? envelope : null;
  } catch {
    return null;
  }
}

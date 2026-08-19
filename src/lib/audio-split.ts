import "server-only";
import type { AudioMime } from "./audio";

/**
 * Zerlegt eine Aufnahme in kurze Abschnitte.
 *
 * Hintergrund: Der Transkriptionsdienst antwortet auf lange Aufnahmen nicht
 * mehr rechtzeitig – das Gateway bricht die Anfrage mit einer
 * Zeitüberschreitung ab, bevor das Modell fertig ist. Statt es mit derselben
 * Datei erneut zu versuchen, wird die Aufnahme in Abschnitte von rund 90
 * Sekunden geteilt, jeder Abschnitt einzeln transkribiert und das Ergebnis
 * anschliessend mit dem passenden Zeitversatz wieder zusammengesetzt.
 *
 * Beide unterstützten Formate lassen sich ohne Neucodierung schneiden:
 *  - WAV: Der Datenteil besteht aus gleich grossen Blöcken; ein Abschnitt ist
 *    ein Ausschnitt daraus mit einem neu geschriebenen 44-Byte-Kopf.
 *  - MP3: Der Datenstrom besteht aus Frames fester Spieldauer; geschnitten
 *    wird ausschliesslich an Frame-Grenzen.
 *
 * Die Bytes eines Abschnitts entstehen erst beim Abruf über `toBytes()`. Eine
 * Aufnahme darf bis zu 50 MB gross sein; würden alle Abschnitte gleichzeitig
 * als Kopie vorliegen, läge der Speicherbedarf beim Doppelten der Datei.
 */

export type AudioChunk = {
  startMs: number;
  endMs: number;
  toBytes: () => Uint8Array;
};

/* --------------------------------------------------------------------- WAV */

export type WavLayout = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationMs: number;
};

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function parseWavLayout(bytes: Uint8Array): WavLayout | null {
  if (bytes.length < 44) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: Omit<WavLayout, "dataOffset" | "dataLength" | "durationMs"> | null = null;

  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 24 <= bytes.length) {
      format = {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        byteRate: view.getUint32(offset + 16, true),
        blockAlign: view.getUint16(offset + 20, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    }
    if (id === "data" && format && format.byteRate > 0 && format.blockAlign > 0) {
      const dataOffset = offset + 8;
      const dataLength = Math.min(size, bytes.length - dataOffset);
      return {
        ...format,
        dataOffset,
        dataLength,
        durationMs: Math.round((dataLength / format.byteRate) * 1000),
      };
    }
    // Chunk-Grössen sind auf gerade Byte-Positionen ausgerichtet.
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** Baut aus einem Ausschnitt des Datenteils eine eigenständige WAV-Datei. */
function wavSlice(bytes: Uint8Array, layout: WavLayout, from: number, to: number): Uint8Array {
  const body = bytes.subarray(layout.dataOffset + from, layout.dataOffset + to);
  const out = new Uint8Array(44 + body.length);
  const view = new DataView(out.buffer);
  const write = (position: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      out[position + index] = text.charCodeAt(index);
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + body.length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, layout.audioFormat, true);
  view.setUint16(22, layout.channels, true);
  view.setUint32(24, layout.sampleRate, true);
  view.setUint32(28, layout.byteRate, true);
  view.setUint16(32, layout.blockAlign, true);
  view.setUint16(34, layout.bitsPerSample, true);
  write(36, "data");
  view.setUint32(40, body.length, true);
  out.set(body, 44);
  return out;
}

function splitWav(bytes: Uint8Array, targetMs: number): AudioChunk[] | null {
  const layout = parseWavLayout(bytes);
  // Nur unkomprimierte Formate (PCM, IEEE-Float) lassen sich blockweise
  // schneiden, ohne den Kopf um weitere Angaben ergänzen zu müssen.
  if (!layout || (layout.audioFormat !== 1 && layout.audioFormat !== 3)) return null;
  if (layout.dataLength <= 0) return null;

  const align = Math.max(layout.blockAlign, 1);
  const bytesPerChunk = Math.max(
    Math.floor(((targetMs / 1000) * layout.byteRate) / align) * align,
    align,
  );

  const chunks: AudioChunk[] = [];
  for (let start = 0; start < layout.dataLength; start += bytesPerChunk) {
    const from = start;
    const to = Math.min(from + bytesPerChunk, layout.dataLength);
    chunks.push({
      startMs: Math.round((from / layout.byteRate) * 1000),
      endMs: Math.round((to / layout.byteRate) * 1000),
      toBytes: () => wavSlice(bytes, layout, from, to),
    });
  }
  return chunks;
}

/* --------------------------------------------------------------------- MP3 */

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

export type Mp3Frame = {
  offset: number;
  length: number;
  durationMs: number;
  /** 3 = MPEG 1, 2 = MPEG 2, 0 = MPEG 2.5 */
  version: number;
  channels: number;
  sampleRate: number;
  /** Auf einen Frame mit Prüfsumme folgen zwei Bytes vor der Seiteninformation. */
  hasCrc: boolean;
  /** Zahl der Granulate im Frame: 2 bei MPEG 1, sonst 1. */
  granules: number;
};

/** Überspringt einen vorangestellten ID3v2-Block. */
function mp3Start(bytes: Uint8Array): number {
  if (bytes.length > 10 && ascii(bytes, 0, 3) === "ID3") {
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

function readMp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;

  const version = (bytes[offset + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (bytes[offset + 1] >> 1) & 0x03; // 1 = Layer III
  const hasCrc = (bytes[offset + 1] & 0x01) === 0;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const rateIndex = (bytes[offset + 2] >> 2) & 0x03;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  const mode = (bytes[offset + 3] >> 6) & 0x03; // 3 = ein Kanal

  if (version === 1 || layer !== 1) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const sampleRate = MP3_SAMPLE_RATES[version]?.[rateIndex];
  const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] * 1000;
  if (!sampleRate || !bitrate) return null;

  const samplesPerFrame = version === 3 ? 1152 : 576;
  const length = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
  if (length < 4 || offset + length > bytes.length) return null;

  return {
    offset,
    length,
    durationMs: (samplesPerFrame / sampleRate) * 1000,
    version,
    channels: mode === 3 ? 1 : 2,
    sampleRate,
    hasCrc,
    granules: version === 3 ? 2 : 1,
  };
}

export function mp3Frames(bytes: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let offset = mp3Start(bytes);
  let misses = 0;
  while (offset + 4 <= bytes.length) {
    const frame = readMp3Frame(bytes, offset);
    if (frame) {
      frames.push(frame);
      offset += frame.length;
      misses = 0;
      continue;
    }
    // Zwischen den Frames stehen gelegentlich Fremddaten; sie werden
    // byteweise übersprungen, bis der nächste Frame-Sync gefunden ist.
    offset += 1;
    misses += 1;
    if (misses > 8192) break;
  }
  return frames;
}

function splitMp3(bytes: Uint8Array, targetMs: number): AudioChunk[] | null {
  const frames = mp3Frames(bytes);
  if (frames.length === 0) return null;

  const chunks: AudioChunk[] = [];
  let startMs = 0;
  let currentMs = 0;
  let from = frames[0].offset;
  let to = frames[0].offset;

  for (const frame of frames) {
    to = frame.offset + frame.length;
    currentMs += frame.durationMs;
    if (currentMs >= targetMs) {
      const [sliceFrom, sliceTo] = [from, to];
      chunks.push({
        startMs: Math.round(startMs),
        endMs: Math.round(startMs + currentMs),
        toBytes: () => bytes.slice(sliceFrom, sliceTo),
      });
      startMs += currentMs;
      currentMs = 0;
      from = to;
    }
  }
  if (to > from) {
    const [sliceFrom, sliceTo] = [from, to];
    chunks.push({
      startMs: Math.round(startMs),
      endMs: Math.round(startMs + currentMs),
      toBytes: () => bytes.slice(sliceFrom, sliceTo),
    });
  }
  return chunks.length > 0 ? chunks : null;
}

/* ------------------------------------------------------------------ Fassade */

/** Spieldauer aus den Rohbytes, unabhängig davon, was beim Upload gemessen wurde. */
export function measureDurationMs(bytes: Uint8Array, mime: AudioMime): number | null {
  if (mime === "audio/wav") return parseWavLayout(bytes)?.durationMs ?? null;
  const frames = mp3Frames(bytes);
  if (frames.length === 0) return null;
  return Math.round(frames.reduce((sum, frame) => sum + frame.durationMs, 0));
}

/**
 * Teilt die Aufnahme in Abschnitte von höchstens `targetMs`. Gibt `null`
 * zurück, wenn das Format nicht verlustfrei geschnitten werden kann; die
 * Aufnahme wird dann unverändert an den Dienst übergeben.
 */
export function splitAudio(
  bytes: Uint8Array,
  mime: AudioMime,
  targetMs: number,
): AudioChunk[] | null {
  const chunks = mime === "audio/wav" ? splitWav(bytes, targetMs) : splitMp3(bytes, targetMs);
  if (!chunks || chunks.length === 0) return null;
  return chunks;
}

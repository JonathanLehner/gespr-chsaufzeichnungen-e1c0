/**
 * Laufzeit der akustischen Ausrichtung: Modell laden, Audio dekodieren,
 * Rechenzeit zuteilen. Die eigentliche Rechnung steht in
 * `shared/ctc-alignment.ts`.
 *
 * Das Modell ist MMS_FA (torchaudio, wav2vec2, 300 Mio. Parameter, für
 * Zwangsausrichtung in über 1000 Sprachen trainiert), beim Bau des Images nach
 * ONNX exportiert und auf int8 quantisiert (`aligner/export_model.py`). Es läuft
 * mit onnxruntime auf der CPU.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InferenceSession } from "onnxruntime-node";
import { ctcAlign, type CtcResult, type Emission } from "./shared/ctc-alignment";
import type { TranscriptSegment } from "./shared/types";

const run = promisify(execFile);
const SAMPLE_RATE = 16_000;

function modelDir(): string {
  return process.env.ALIGNER_MODEL_DIR || join(import.meta.dirname, "models");
}

/* ------------------------------------------------------------ Rechenzeit */

/**
 * Ein Modelllauf zur Zeit je Dienst; er nutzt alle zugeteilten Kerne. Neue
 * Transkriptionen (`hoch`) kommen vor der Neuausrichtung bestehender
 * Transkripte (`niedrig`) an die Reihe. Vergeben wird je Fenster, eine
 * laufende Neuausrichtung hält eine neue Transkription also höchstens ein
 * Fenster lang auf.
 */
export type Priority = "hoch" | "niedrig";

const gate = (() => {
  let busy = false;
  const queues: Record<Priority, (() => void)[]> = { hoch: [], niedrig: [] };
  return {
    async run<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
      if (busy) await new Promise<void>((resolve) => queues[priority].push(resolve));
      busy = true;
      try {
        return await task();
      } finally {
        const next = queues.hoch.shift() ?? queues.niedrig.shift();
        if (next) next();
        else busy = false;
      }
    },
    /** Wartet eine neue Transkription gerade auf das Modell? */
    get urgent(): boolean {
      return queues.hoch.length > 0;
    },
  };
})();

export const alignerBusyWithUrgentWork = () => gate.urgent;

/* ------------------------------------------------------------ Modell */

type Model = { session: InferenceSession; labels: string[]; ort: typeof import("onnxruntime-node") };
let model: Promise<Model> | null = null;

function threads(): number {
  const configured = Number.parseInt(process.env.ALIGNER_THREADS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 1) return configured;
  return Math.max(1, Math.min(availableParallelism(), 4));
}

export function loadModel(): Promise<Model> {
  model ??= (async () => {
    const ort = await import("onnxruntime-node");
    const dir = modelDir();
    const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as string[];
    const session = await ort.InferenceSession.create(join(dir, "mms_fa.int8.onnx"), {
      intraOpNumThreads: threads(),
      interOpNumThreads: 1,
      executionMode: "sequential",
      graphOptimizationLevel: "all",
    });
    return { session, labels, ort };
  })().catch((error) => {
    model = null;
    throw error;
  });
  return model;
}

/** Wie `wav2vec2`s `layer_norm` über den ganzen Ausschnitt. */
function normalize(samples: Float32Array): Float32Array {
  let mean = 0;
  for (const value of samples) mean += value;
  mean /= samples.length || 1;
  let variance = 0;
  for (const value of samples) variance += (value - mean) ** 2;
  variance /= samples.length || 1;
  const scale = 1 / Math.sqrt(variance + 1e-5);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] - mean) * scale;
  return out;
}

async function emissionFor(m: Model, samples: Float32Array): Promise<Emission> {
  const input = new m.ort.Tensor("float32", normalize(samples), [1, samples.length]);
  const output = await m.session.run({ audio: input });
  const tensor = output.logprobs;
  const [, frames, vocab] = tensor.dims as number[];
  const logProbs = tensor.data as Float32Array;
  input.dispose?.();
  return { logProbs, frames, vocab, frameMs: samples.length / frames / (SAMPLE_RATE / 1000) };
}

/* ------------------------------------------------------------ Audio */

/** Dekodiert eine Audiodatei zu 16 kHz Mono-Float, so wie das Modell sie erwartet. */
export async function decodeAudio(file: string): Promise<Float32Array> {
  const { stdout } = await run(
    "ffmpeg",
    ["-loglevel", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
  );
  const bytes = stdout as Buffer;
  const copy = new Uint8Array(bytes.length - (bytes.length % 4));
  copy.set(bytes.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

/* ------------------------------------------------------------ Fassade */

export type AcousticOptions = {
  priority: Priority;
  signal?: AbortSignal;
  padMs?: number;
  maxWindowMs?: number;
};

/**
 * Richtet ein Transkript an den dekodierten Abtastwerten aus. Die Satzzeiten
 * der Eingabe bestimmen die Fenster; die Ausgabe trägt neue Wort- und
 * Satzzeiten, Text und Sprecher bleiben gleich.
 */
export async function alignAcoustically(
  segments: TranscriptSegment[],
  samples: Float32Array,
  options: AcousticOptions,
): Promise<CtcResult> {
  const m = await loadModel();
  const durationMs = Math.floor((samples.length / SAMPLE_RATE) * 1000);
  return ctcAlign(
    segments,
    m.labels,
    (fromMs, toMs) => {
      options.signal?.throwIfAborted();
      const from = Math.floor((fromMs / 1000) * SAMPLE_RATE);
      const to = Math.min(samples.length, Math.ceil((toMs / 1000) * SAMPLE_RATE));
      return gate.run(options.priority, () => emissionFor(m, samples.subarray(from, to)));
    },
    { durationMs, padMs: options.padMs, maxWindowMs: options.maxWindowMs },
  );
}

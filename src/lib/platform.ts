import "server-only";

const BASE = "https://www.clawcorp.ai/api/platform";

function apiKey(): string {
  const key = process.env.CLAWCORP_API_KEY;
  if (!key) throw new Error("CLAWCORP_API_KEY ist nicht gesetzt.");
  return key;
}

async function post<T>(path: string, body: unknown, contentType = "application/json"): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": contentType,
    },
    body: contentType === "application/json" ? JSON.stringify(body) : (body as BodyInit),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* Rohtext verwenden */
    }
    throw new PlatformError(`${path} fehlgeschlagen (${res.status}): ${message}`, res.status, message);
  }
  return JSON.parse(text) as T;
}

export class PlatformError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.detail = detail;
  }
}

/* ---------------------------------------------------------------- Datenbank */

export type DbAction =
  | "find"
  | "findOne"
  | "insertOne"
  | "insertMany"
  | "updateOne"
  | "updateMany"
  | "deleteOne"
  | "deleteMany"
  | "countDocuments";

type DbRequest = {
  collection: string;
  action: DbAction;
  filter?: Record<string, unknown>;
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  update?: Record<string, unknown>;
};

export async function platformDb<T>(request: DbRequest): Promise<T> {
  const { result } = await post<{ result: T }>("/db", request);
  return result;
}

/* ------------------------------------------------------------------ Gemini */

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } };

export type GeminiRequest = {
  model?: string;
  prompt?: string;
  contents?: { role: "user" | "model"; parts: GeminiPart[] }[];
  generationConfig?: Record<string, unknown>;
};

export type GeminiResponse = {
  text: string;
  images?: { url: string; mimeType: string }[];
  model?: string;
};

export async function platformGemini(request: GeminiRequest): Promise<GeminiResponse> {
  return post<GeminiResponse>("/gemini", request);
}

/* ------------------------------------------------------------- Dateiablage */

export type UploadResult = { url: string; bytes: number };

/**
 * Legt Rohbytes im ClawCorp-S3-Speicher ab und liefert die dauerhafte URL.
 *
 * Die Ablage nimmt Audio-MIME-Typen nicht direkt entgegen, deshalb werden die
 * unveränderten Bytes als Medien-Container übergeben. Der tatsächliche Typ der
 * Aufnahme steht im Datensatz und wird von /api/audio beim Ausliefern gesetzt.
 */
export async function platformUploadAudio(bytes: Uint8Array | Buffer): Promise<UploadResult> {
  return post<UploadResult>("/upload", bytes, "video/mp4");
}

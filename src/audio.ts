import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { paymentOverheadUsd } from "./gas.js";

// ---------------------------------------------------------------------------
// Audio upstream (TTS + STT) — routed through the admin combo router
// (COMBO_UPSTREAM_BASE_URL), so provider credentials and the geo-unblocking
// proxy live only in the admin panel's provider connections.
//
// Public OpenAI-compatible surface:
//   POST /v1/audio/speech          {model, input, voice?, response_format?}
//   POST /v1/audio/transcriptions  multipart file+model, or JSON {file: dataURI|base64}
// ---------------------------------------------------------------------------

function priceEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(name + " must be a positive number");
  return value;
}

export const speechPriceUsd = priceEnv("AUDIO_TTS_PRICE_USD", 0.015);
export const transcriptionPriceUsd = priceEnv("AUDIO_STT_PRICE_USD", 0.006);

/** Public model ids -> ordered upstream candidates on the admin audio router
 *  ("provider/model"); the first entry is the primary, the rest are
 *  cross-provider fallbacks used after the primary's own retries exhaust. */
const ttsUpstreams: Record<string, string[]> = {
  "tts-1": [process.env.AUDIO_TTS_UPSTREAM ?? "gemini/gemini-3.8-flash-lite-tts", "groq/canopylabs/orpheus-v1-english"],
  "tts-1-hd": [process.env.AUDIO_TTS_HD_UPSTREAM ?? "gemini/gemini-3.8-flash-tts", "groq/canopylabs/orpheus-v1-english"],
  "orpheus-english": [process.env.AUDIO_TTS_ORPHEUS_EN_UPSTREAM ?? "groq/canopylabs/orpheus-v1-english", "gemini/gemini-3.8-flash-lite-tts"],
  // Only Groq carries an emotive Arabic voice; degrading to a non-Arabic one would be worse than none.
  "orpheus-arabic": [process.env.AUDIO_TTS_ORPHEUS_AR_UPSTREAM ?? "groq/canopylabs/orpheus-arabic-saudi"],
};
const sttUpstreams: Record<string, string[]> = {
  "whisper-1": [process.env.AUDIO_STT_UPSTREAM ?? "gemini/gemini-3.5-transcribe", "groq/whisper-large-v3"],
  "whisper-large-v3": [process.env.AUDIO_STT_V3_UPSTREAM ?? "groq/whisper-large-v3", "gemini/gemini-3.5-transcribe"],
  "whisper-large-v3-turbo": [process.env.AUDIO_STT_TURBO_UPSTREAM ?? "groq/whisper-large-v3-turbo", "gemini/gemini-3.5-transcribe"],
};

export const speechModels = Object.keys(ttsUpstreams);
export const transcriptionModels = Object.keys(sttUpstreams);
export const audioComboEnabled = Boolean(config.internalComboKey);
export const speechEnabled = audioComboEnabled;
export const transcriptionsEnabled = audioComboEnabled;

/** OpenAI voice presets -> Gemini prebuilt voices (forwarded to the admin router). */
const VOICE_MAP: Record<string, string> = {
  alloy: "Kore",
  ash: "Orus",
  ballad: "Aoede",
  coral: "Callirrhoe",
  echo: "Puck",
  fable: "Leda",
  nova: "Despina",
  onyx: "Charon",
  sage: "Schedar",
  shimmer: "Zephyr",
};
const DEFAULT_VOICE = "Kore";

/** Per-model default voices; Groq voices pass through untranslated. */
const MODEL_DEFAULT_VOICE: Record<string, string> = {
  "tts-1": DEFAULT_VOICE,
  "tts-1-hd": DEFAULT_VOICE,
  "orpheus-english": "autumn",
  "orpheus-arabic": "fahad",
};

export interface SpeechRequest {
  model: string;
  input: string;
  voice: string;
  /** Forwarded only where the upstream honors it (Groq Orpheus); ignored on Gemini. */
  speed?: number;
}

export function parseSpeechRequest(body: Record<string, unknown>): SpeechRequest | string {
  const { model, input, voice, response_format, speed } = body;
  if (typeof model !== "string" || !ttsUpstreams[model]) {
    return "Unknown TTS model; supported: " + speechModels.join(", ");
  }
  if (typeof input !== "string" || !input.trim() || input.length > 5000) {
    return "input must be 1 to 5000 characters";
  }
  if (voice !== undefined && typeof voice !== "string") return "voice must be a string";
  if (response_format !== undefined && response_format !== "wav") {
    return "response_format must be wav (the only audio container currently served)";
  }
  if (speed !== undefined && (typeof speed !== "number" || speed < 0.25 || speed > 4)) {
    return "speed must be a number from 0.25 to 4";
  }
  const isGroq = ttsUpstreams[model][0].startsWith("groq/");
  const resolvedVoice =
    typeof voice === "string" && voice
      ? isGroq
        ? voice
        : VOICE_MAP[voice.toLowerCase()] ?? voice
      : MODEL_DEFAULT_VOICE[model];
  return {
    model,
    input,
    voice: resolvedVoice,
    ...(isGroq && typeof speed === "number" ? { speed } : {}),
  };
}

export function validateSpeech(req: Request, res: Response, next: NextFunction): void {
  if (!speechEnabled) {
    res.status(503).json({ error: { message: "TTS is not configured" } });
    return;
  }
  const parsed = parseSpeechRequest(req.body ?? {});
  if (typeof parsed === "string") {
    res.status(400).json({ error: { type: "invalid_request", message: parsed } });
    return;
  }
  res.locals.speechRequest = parsed;
  next();
}

const TRANSCRIPTION_FORMATS = new Set(["json", "text", "verbose_json", "srt", "vtt"]);

export interface TranscriptionRequest {
  model: string;
  audio: Buffer;
  mimeType: string;
  fileName: string;
  responseFormat: string;
}

function guessAudioMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = {
    mp3: "audio/mpeg", mpga: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
    mp4: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm",
    flac: "audio/flac", aac: "audio/aac", opus: "audio/ogg",
  };
  return byExt[ext] ?? "audio/mpeg";
}

function fileNameForMime(mimeType: string): string {
  const byMime: Record<string, string> = {
    "audio/mpeg": "audio.mp3",
    "audio/mp3": "audio.mp3",
    "audio/wav": "audio.wav",
    "audio/x-wav": "audio.wav",
    "audio/mp4": "audio.m4a",
    "audio/ogg": "audio.ogg",
    "audio/webm": "audio.webm",
    "audio/flac": "audio.flac",
    "audio/aac": "audio.aac",
  };
  return byMime[mimeType.toLowerCase()] ?? "audio.mp3";
}

// ---------------------------------------------------------------------------
// Multipart parsing (no external parser dependency)
// ---------------------------------------------------------------------------

interface MultipartFile {
  data: Buffer;
  contentType: string;
  filename: string;
}

export function parseMultipartForm(
  body: Buffer,
  contentTypeHeader: string,
): { fields: Record<string, string>; file?: MultipartFile } | string {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentTypeHeader);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return "multipart boundary missing";
  const delimiter = Buffer.from("--" + boundary);
  const fields: Record<string, string> = {};
  let file: MultipartFile | undefined;

  let start = body.indexOf(delimiter);
  if (start < 0) return "multipart body malformed";
  for (;;) {
    start += delimiter.length;
    if (body.subarray(start, start + 2).toString() === "--") break; // closing boundary
    if (body.subarray(start, start + 2).toString() === "\r\n") start += 2;
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd < 0) return "multipart part headers unterminated";
    const headers = body.subarray(start, headerEnd).toString("latin1");
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next < 0) return "multipart boundary not found after part";
    // Strip the CRLF right before the next boundary.
    const content = body.subarray(headerEnd + 4, body.lastIndexOf("\r\n", next));

    const nameMatch = /[;\s]name="([^"]*)"/i.exec(headers);
    const filenameMatch = /filename="([^"]*)"/i.exec(headers);
    if (!nameMatch && !filenameMatch) {
      start = next;
      continue;
    }
    if (filenameMatch) {
      const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headers);
      file = {
        data: content,
        contentType: typeMatch?.[1]?.trim() ?? "",
        filename: filenameMatch[1],
      };
    } else if (nameMatch) {
      fields[nameMatch[1]] = content.toString("utf8");
    }
    start = next;
  }
  return { fields, file };
}

export function parseTranscriptionRequest(req: Request): TranscriptionRequest | string {
  let audio: Buffer | undefined;
  let mimeType = "";
  let fileName = "audio.mp3";
  let model: unknown;
  let responseFormat: unknown;

  if (Buffer.isBuffer(req.body)) {
    const parsed = parseMultipartForm(req.body, req.get("content-type") ?? "");
    if (typeof parsed === "string") return parsed;
    model = parsed.fields.model;
    responseFormat = parsed.fields.response_format;
    if (!parsed.file || parsed.file.data.length === 0) return "multipart file field is required";
    audio = parsed.file.data;
    fileName = parsed.file.filename || fileName;
    mimeType = parsed.file.contentType.startsWith("audio/")
      ? parsed.file.contentType.trim()
      : guessAudioMime(parsed.file.filename);
  } else {
    const body = (req.body ?? {}) as Record<string, unknown>;
    model = body.model;
    responseFormat = body.response_format;
    if (typeof body.file !== "string" || !body.file) {
      return "file is required: multipart field or JSON base64/data-URI in \"file\"";
    }
    const dataUri = /^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(body.file);
    if (dataUri) {
      audio = Buffer.from(dataUri[2], "base64");
      mimeType = dataUri[1].toLowerCase();
    } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(body.file) && body.file.length > 100) {
      audio = Buffer.from(body.file, "base64");
      mimeType = typeof body.mime_type === "string" && body.mime_type.startsWith("audio/")
        ? body.mime_type
        : "audio/mpeg";
    } else {
      return "file must be a base64 string or an audio data URI";
    }
    fileName = fileNameForMime(mimeType);
  }

  const resolvedModel = model === undefined || model === "" ? "whisper-1" : String(model);
  if (!transcriptionModels.includes(resolvedModel)) {
    return "Unknown transcription model; supported: " + transcriptionModels.join(", ");
  }
  // Word/segment timestamps and subtitle formats are only served by the Groq whisper upstream.
  if (typeof responseFormat === "string" && ["verbose_json", "srt", "vtt"].includes(responseFormat) &&
      !sttUpstreams[resolvedModel][0].startsWith("groq/")) {
    return "response_format " + responseFormat + " requires a whisper-* model (groq backend)";
  }
  if (!audio || audio.length === 0) return "audio file is empty";
  if (audio.length > 25_000_000) return "audio file exceeds 25 MB";
  if (
    responseFormat !== undefined &&
    responseFormat !== "" &&
    !TRANSCRIPTION_FORMATS.has(String(responseFormat))
  ) {
    return "response_format must be one of: " + [...TRANSCRIPTION_FORMATS].join(", ");
  }
  return {
    model: resolvedModel,
    audio,
    mimeType,
    fileName,
    responseFormat: responseFormat ? String(responseFormat) : "json",
  };
}

export function validateTranscription(req: Request, res: Response, next: NextFunction): void {
  if (!transcriptionsEnabled) {
    res.status(503).json({ error: { message: "Transcription is not configured" } });
    return;
  }
  const parsed = parseTranscriptionRequest(req);
  if (typeof parsed === "string") {
    res.status(400).json({ error: { type: "invalid_request", message: parsed } });
    return;
  }
  res.locals.transcriptionRequest = parsed;
  next();
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export async function quoteSpeech(_body: Record<string, unknown>): Promise<string> {
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, speechPriceUsd + overhead).toFixed(6);
}

export async function quoteTranscription(_body: Record<string, unknown>): Promise<string> {
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, transcriptionPriceUsd + overhead).toFixed(6);
}

// ---------------------------------------------------------------------------
// Admin combo upstream
// ---------------------------------------------------------------------------

// Transient upstream failures worth one retry inside the same paid request.
const AUDIO_RETRYABLE = new Set([429, 500, 502, 503, 504]);
const AUDIO_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface UpstreamCall {
  path: string;
  headers: Record<string, string>;
  body: BodyInit;
}

async function callAudioUpstream(call: UpstreamCall): Promise<globalThis.Response> {
  const key = config.internalComboKey;
  if (!key) throw new Error("Combo router credential missing");
  let lastStatus = 0;
  for (let attempt = 1; attempt <= AUDIO_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(config.comboUpstreamBaseUrl + call.path, {
        method: "POST",
        headers: { ...call.headers, authorization: "Bearer " + key },
        body: call.body,
        signal: AbortSignal.timeout(240_000),
      });
      if (response.ok || !AUDIO_RETRYABLE.has(response.status) || attempt === AUDIO_MAX_ATTEMPTS) {
        return response;
      }
      lastStatus = response.status;
      console.warn("[audio] combo router HTTP " + response.status + ", retry " + attempt);
      await response.body?.cancel();
    } catch (error) {
      if (attempt === AUDIO_MAX_ATTEMPTS) throw error;
      console.warn("[audio] combo router transport error, retry " + attempt + ":",
        error instanceof Error ? error.name : "unknown");
    }
    await sleep(attempt * 2000);
  }
  const error = new Error("Audio upstream failed with HTTP " + lastStatus) as Error & { status: number };
  error.status = lastStatus;
  throw error;
}

async function failureFrom(response: globalThis.Response, what: string): Promise<Error> {
  const raw = await response.text();
  console.error("[audio] " + what + " HTTP " + response.status + ": " + raw.slice(0, 400));
  const error = new Error(what + " failed with HTTP " + response.status) as Error & { status: number };
  error.status = response.status;
  return error;
}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
  /** Upstream that actually served (first entry = primary). */
  upstream: string;
  /** True when a fallback upstream served instead of the primary. Voice differs then. */
  fellBack: boolean;
}

/** Voice used when falling back to a different vendor (their native default). */
function upstreamDefaultVoice(upstream: string): string {
  if (upstream.endsWith("orpheus-v1-english")) return "autumn";
  if (upstream.endsWith("orpheus-arabic-saudi")) return "fahad";
  return DEFAULT_VOICE;
}

export async function fetchSpeech(req: SpeechRequest): Promise<SpeechResult> {
  const candidates = ttsUpstreams[req.model];
  for (const [index, upstream] of candidates.entries()) {
    // The admin router defaults response_format to "mp3"; Groq Orpheus only
    // accepts "wav" and Gemini ignores the field, so pin it here.
    const body = JSON.stringify({
      model: upstream,
      input: req.input,
      voice: index === 0 ? req.voice : upstreamDefaultVoice(upstream),
      response_format: "wav",
      ...(req.speed !== undefined ? { speed: req.speed } : {}),
    });
    let response: globalThis.Response;
    try {
      response = await callAudioUpstream({ path: "/audio/speech", headers: { "content-type": "application/json" }, body });
    } catch (error) {
      // Transport failure after in-provider retries — try the next vendor.
      if (index < candidates.length - 1) {
        console.warn("[audio] speech upstream " + upstream + " transport failure, falling back");
        continue;
      }
      throw error;
    }
    if (response.ok) {
      if (index > 0) console.warn("[audio] speech served by fallback " + upstream);
      const contentType = response.headers.get("content-type") ?? "audio/wav";
      return { audio: Buffer.from(await response.arrayBuffer()), contentType, upstream, fellBack: index > 0 };
    }
    if (!AUDIO_RETRYABLE.has(response.status) || index === candidates.length - 1) {
      throw await failureFrom(response, "speech");
    }
    console.warn("[audio] speech upstream " + upstream + " HTTP " + response.status + ", falling back");
    await response.body?.cancel();
  }
  throw new Error("speech failed on all upstreams");
}

export interface TranscriptionResult {
  raw: string;
  contentType: string;
  /** Upstream that actually served (first entry = primary). */
  upstream: string;
  fellBack: boolean;
}

export async function fetchTranscription(req: TranscriptionRequest): Promise<TranscriptionResult> {
  // Timestamp/subtitle formats only exist on the Groq whisper upstream —
  // falling back to Gemini would silently change the response shape.
  const candidates =
    req.responseFormat === "json" || req.responseFormat === "text"
      ? sttUpstreams[req.model]
      : [sttUpstreams[req.model][0]];
  for (const [index, upstream] of candidates.entries()) {
    const form = new FormData();
    form.set("model", upstream);
    form.set("response_format", req.responseFormat);
    form.set("file", new Blob([new Uint8Array(req.audio)], { type: req.mimeType }), req.fileName);
    let response: globalThis.Response;
    try {
      response = await callAudioUpstream({ path: "/audio/transcriptions", headers: {}, body: form });
    } catch (error) {
      if (index < candidates.length - 1) {
        console.warn("[audio] transcription upstream " + upstream + " transport failure, falling back");
        continue;
      }
      throw error;
    }
    if (response.ok) {
      if (index > 0) console.warn("[audio] transcription served by fallback " + upstream);
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "application/json";
      if (req.responseFormat === "json" || req.responseFormat === "verbose_json") {
        try {
          const data = JSON.parse(raw) as { text?: unknown };
          if (typeof data.text !== "string" || !data.text.trim()) {
            throw new Error("Transcription upstream returned no text");
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error("Transcription upstream returned invalid JSON");
          }
          throw error;
        }
      }
      return { raw, contentType, upstream, fellBack: index > 0 };
    }
    if (!AUDIO_RETRYABLE.has(response.status) || index === candidates.length - 1) {
      throw await failureFrom(response, "transcription");
    }
    console.warn("[audio] transcription upstream " + upstream + " HTTP " + response.status + ", falling back");
    await response.body?.cancel();
  }
  throw new Error("transcription failed on all upstreams");
}

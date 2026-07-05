import "dotenv/config";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Google AI Studio key from https://aistudio.google.com/apikey
  apiKey:
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    "",
  baseUrl:
    process.env.GEMINI_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta/openai/",
  model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  timeoutMs: int(process.env.GEMINI_TIMEOUT_MS, 30000),
  port: int(process.env.PORT, 8787),
  // 1 retry means 2 total attempts per call.
  maxRetries: int(process.env.GEMINI_MAX_RETRIES, 1),
};

export function assertApiKey() {
  if (!config.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env and add your Google AI Studio key from https://aistudio.google.com/apikey"
    );
  }
}

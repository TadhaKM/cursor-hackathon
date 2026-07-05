import "dotenv/config";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  apiKey: process.env.GEMINI_API_KEY ?? "",
  baseUrl:
    process.env.GEMINI_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta/openai",
  model: process.env.GEMINI_MODEL ?? "gemini-flash-latest",
  timeoutMs: int(process.env.GEMINI_TIMEOUT_MS, 90000),
  port: int(process.env.PORT, 8787),
  // 1 retry means 2 total attempts per Gemini call.
  maxRetries: int(process.env.GEMINI_MAX_RETRIES, 1),
  // Rate-limit (429) gets its own, more generous retry budget: free-tier Gemini
  // keys throttle a multi-call /explain run, and the server tells us how long
  // to wait, so honoring that recovers automatically.
  rateLimitMaxRetries: int(process.env.GEMINI_RATE_LIMIT_RETRIES, 4),
  rateLimitMaxDelayMs: int(process.env.GEMINI_RATE_LIMIT_MAX_DELAY_MS, 35000),
};

export function assertApiKey() {
  if (!config.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env and add your Google AI Studio key."
    );
  }
}

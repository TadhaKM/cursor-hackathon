import "dotenv/config";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

// Prefer GEMINI_* env vars; fall back to the legacy QWEN_* names so existing
// local/deploy configs keep working.
const env = process.env;
const pick = (a, b) => a ?? b;

export const config = {
  apiKey: pick(env.GEMINI_API_KEY, env.QWEN_API_KEY) ?? "",
  baseUrl:
    pick(env.GEMINI_BASE_URL, env.QWEN_BASE_URL) ??
    "https://generativelanguage.googleapis.com/v1beta/openai",
  model: pick(env.GEMINI_MODEL, env.QWEN_MODEL) ?? "gemini-2.5-flash",
  timeoutMs: int(pick(env.GEMINI_TIMEOUT_MS, env.QWEN_TIMEOUT_MS), 90000),
  port: int(env.PORT, 8787),
  // 1 retry means 2 total generic attempts per LLM call (429/503 have their
  // own, larger retry budgets — see geminiClient.js).
  maxRetries: int(pick(env.GEMINI_MAX_RETRIES, env.QWEN_MAX_RETRIES), 1),
  // Per-section narration resize makes ONE extra LLM call per out-of-range
  // section. Off by default to conserve rate-limited free-tier quota; set
  // REFINE_NARRATION=true to re-enable.
  refineNarration: (env.REFINE_NARRATION ?? "false").toLowerCase() === "true",
};

export function assertApiKey() {
  if (!config.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env and add your Google AI Studio key."
    );
  }
}

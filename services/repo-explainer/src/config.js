import "dotenv/config";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

// The client is OpenAI-compatible, so it works with any provider that speaks
// that API. Prefer OPENROUTER_* env vars, then legacy GEMINI_* / QWEN_* names
// so older configs keep working. Empty strings are treated as unset.
const env = process.env;
const first = (...vals) => vals.find((v) => v != null && v !== "");

export const config = {
  apiKey: first(env.OPENROUTER_API_KEY, env.GEMINI_API_KEY, env.QWEN_API_KEY) ?? "",
  baseUrl:
    first(env.OPENROUTER_BASE_URL, env.GEMINI_BASE_URL, env.QWEN_BASE_URL) ??
    "https://openrouter.ai/api/v1",
  model:
    first(env.OPENROUTER_MODEL, env.GEMINI_MODEL, env.QWEN_MODEL) ??
    "google/gemini-2.5-flash",
  timeoutMs: int(
    first(env.OPENROUTER_TIMEOUT_MS, env.GEMINI_TIMEOUT_MS, env.QWEN_TIMEOUT_MS),
    90000
  ),
  port: int(env.PORT, 8787),
  // Cap completion tokens. Without this the SDK requests the model max, which
  // OpenRouter's free tier rejects with a 402 ("requires more credits, or
  // fewer max_tokens"). 8000 is plenty for the summary/narration/mermaid.
  maxTokens: int(first(env.OPENROUTER_MAX_TOKENS, env.GEMINI_MAX_TOKENS), 8000),
  // 1 retry means 2 total generic attempts per LLM call (429/503 have their
  // own, larger retry budgets — see geminiClient.js).
  maxRetries: int(first(env.GEMINI_MAX_RETRIES, env.QWEN_MAX_RETRIES), 1),
  // Per-section narration resize makes ONE extra LLM call per out-of-range
  // section. Off by default to conserve rate-limited quota; set
  // REFINE_NARRATION=true to re-enable.
  refineNarration: (env.REFINE_NARRATION ?? "false").toLowerCase() === "true",
};

export function assertApiKey() {
  if (!config.apiKey) {
    throw new Error(
      "No LLM API key set. Copy .env.example to .env and add OPENROUTER_API_KEY."
    );
  }
}

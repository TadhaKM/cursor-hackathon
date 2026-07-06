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

const anthropicApiKey = first(env.ANTHROPIC_API_KEY, env.CLAUDE_API_KEY) ?? "";

// /explain provider. Defaults to Anthropic (Claude) when an Anthropic key is
// present — it's far more reliable than free OpenRouter/Gemini tiers (which
// 429/503 constantly). Force with EXPLAIN_PROVIDER=anthropic|openai.
const explainProvider = (
  env.EXPLAIN_PROVIDER ?? (anthropicApiKey ? "anthropic" : "openai")
).toLowerCase();

// Model for /explain per provider. Claude Sonnet handles the large prompts well.
const explainModel =
  explainProvider === "anthropic"
    ? first(env.EXPLAIN_MODEL, env.ANTHROPIC_MODEL, env.CLAUDE_MODEL) ?? "claude-sonnet-5"
    : first(env.OPENROUTER_MODEL, env.GEMINI_MODEL, env.QWEN_MODEL) ?? "google/gemini-2.5-flash";

export const config = {
  // Which provider /explain uses: "anthropic" (Claude SDK) or "openai"
  // (OpenAI-compatible endpoint — OpenRouter/Gemini).
  explainProvider,
  apiKey:
    explainProvider === "anthropic"
      ? anthropicApiKey
      : first(env.OPENROUTER_API_KEY, env.GEMINI_API_KEY, env.QWEN_API_KEY) ?? "",
  baseUrl:
    first(env.OPENROUTER_BASE_URL, env.GEMINI_BASE_URL, env.QWEN_BASE_URL) ??
    "https://openrouter.ai/api/v1",
  model: explainModel,
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

  // --- RAG /chat ---
  // Chat uses Anthropic (Claude) when ANTHROPIC_API_KEY is set — free-tier
  // OpenRouter models are unreliable (constant 429/deprecations), and Claude
  // gives grounded, high-quality answers. Falls back to OpenRouter otherwise.
  anthropicApiKey,
  anthropicModel:
    first(env.ANTHROPIC_CHAT_MODEL, env.ANTHROPIC_MODEL, env.CLAUDE_MODEL) ?? "claude-sonnet-5",
  // Max tokens for a chat answer (2-4 sentences; keeps latency/cost sane).
  chatMaxTokens: int(first(env.CHAT_MAX_TOKENS), 700),
  // OpenRouter fallback: its free auto-router ("openrouter/free") picks an
  // available free model per request. Override with OPENROUTER_CHAT_MODEL.
  chatModel: first(env.OPENROUTER_CHAT_MODEL) ?? "openrouter/free",
  chatFallbackModel: first(env.OPENROUTER_CHAT_FALLBACK_MODEL) ?? "",
  // Cap the wait on a chat call (spec: 20s).
  chatTimeoutMs: int(first(env.CHAT_TIMEOUT_MS, env.OPENROUTER_CHAT_TIMEOUT_MS), 20000),
  // Sent as HTTP-Referer / X-Title for OpenRouter dashboard attribution.
  appReferer: first(env.OPENROUTER_APP_REFERER) ?? "https://redio.app",
  appTitle: first(env.OPENROUTER_APP_TITLE) ?? "Redio",
};

export function assertApiKey() {
  if (!config.apiKey) {
    throw new Error(
      config.explainProvider === "anthropic"
        ? "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add it."
        : "No LLM API key set. Copy .env.example to .env and add OPENROUTER_API_KEY."
    );
  }
}

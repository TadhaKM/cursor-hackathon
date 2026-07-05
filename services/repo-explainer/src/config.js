import "dotenv/config";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  apiKey: process.env.QWEN_API_KEY ?? "",
  baseUrl:
    process.env.QWEN_BASE_URL ??
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  model: process.env.QWEN_MODEL ?? "qwen-max",
  timeoutMs: int(process.env.QWEN_TIMEOUT_MS, 30000),
  port: int(process.env.PORT, 8787),
  // 1 retry means 2 total attempts per Qwen call.
  maxRetries: int(process.env.QWEN_MAX_RETRIES, 1),
  // Rate-limit (429) gets its own, more generous retry budget: free-tier
  // Gemini/Qwen keys throttle a multi-call /explain run, and the server tells
  // us how long to wait, so honoring that recovers automatically.
  rateLimitMaxRetries: int(process.env.QWEN_RATE_LIMIT_RETRIES, 4),
  rateLimitMaxDelayMs: int(process.env.QWEN_RATE_LIMIT_MAX_DELAY_MS, 35000),
};

export function assertApiKey() {
  if (!config.apiKey) {
    throw new Error(
      "QWEN_API_KEY is not set. Copy .env.example to .env and add your Model Studio key."
    );
  }
}

import OpenAI from "openai";
import { config } from "./config.js";

// Typed error so the HTTP layer can map failures to clean status codes.
export class QwenError extends Error {
  constructor(message, { statusCode = 502, kind = "upstream", cause } = {}) {
    super(message);
    this.name = "QwenError";
    this.statusCode = statusCode;
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

// Map a raw SDK/network error to a (statusCode, kind) pair.
export function classifyQwenError(err) {
  const status = err?.status ?? err?.response?.status;
  const code = err?.code;
  const name = err?.name ?? "";
  const msg = String(err?.message ?? "").toLowerCase();

  const isTimeout =
    err instanceof OpenAI.APIConnectionTimeoutError ||
    name.toLowerCase().includes("timeout") ||
    code === "ETIMEDOUT" ||
    code === "ETIME" ||
    code === "ESOCKETTIMEDOUT" ||
    msg.includes("timed out") ||
    msg.includes("timeout");
  if (isTimeout) return { statusCode: 504, kind: "timeout" };

  const isAuth =
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError ||
    status === 401 ||
    status === 403;
  if (isAuth) return { statusCode: 500, kind: "auth" };

  const isRateLimit =
    err instanceof OpenAI.RateLimitError ||
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("quota");
  if (isRateLimit) return { statusCode: 429, kind: "rate_limit" };

  // 503 / "model is overloaded" is transient — worth backing off and retrying.
  const isOverloaded =
    status === 503 ||
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("try again");
  if (isOverloaded) return { statusCode: 503, kind: "overloaded" };

  return { statusCode: 502, kind: "upstream" };
}

// Pull a "how long to wait" hint out of a 429 error. Tries the standard
// Retry-After header, then the RetryInfo/"retry in Xs" hints the Gemini and
// Qwen compat layers put in the body/message. Falls back to escalating backoff.
export function retryDelayMsFor(err, attempt, capMs = 35000) {
  const header =
    err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
  const headerSec = Number.parseFloat(header);
  if (Number.isFinite(headerSec) && headerSec > 0) {
    return Math.min(headerSec * 1000, capMs);
  }

  const text = `${err?.message ?? ""} ${
    typeof err?.error === "object" ? JSON.stringify(err.error) : err?.error ?? ""
  }`;
  const match =
    text.match(/retry(?:Delay)?["\s:]*?([\d.]+)\s*s/i) ||
    text.match(/retry in\s*([\d.]+)\s*s/i);
  if (match) {
    const sec = Number.parseFloat(match[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000 + 500, capMs);
  }

  // No hint: escalate 5s, 12s, 24s, … capped.
  return Math.min(5000 * 2 ** (attempt - 1) + 1000, capMs);
}

// Single OpenAI-compatible client pointed at Qwen Model Studio.
// The SDK's built-in `maxRetries` is disabled; we handle retries ourselves so
// the semantics ("1 retry per call") are explicit and easy to reason about.
let client = null;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single chat completion against Qwen with an explicit timeout and a
 * bounded number of retries.
 *
 * @param {object} opts
 * @param {string} opts.system        System prompt.
 * @param {string} opts.user          User prompt.
 * @param {boolean} [opts.json]       Ask the model for a JSON object response.
 * @param {number} [opts.temperature] Sampling temperature.
 * @param {string} [opts.label]       Human label used in error messages/logs.
 * @returns {Promise<string>} The assistant message content.
 */
export async function chat({
  system,
  user,
  json = false,
  temperature = 0.4,
  label = "qwen-call",
}) {
  let lastError;
  // Two independent budgets: transient errors (timeout/upstream) get the small
  // maxRetries budget; rate-limit (429) gets its own, larger budget since a
  // multi-call /explain run routinely trips free-tier quotas and recovers once
  // the window resets.
  let transientLeft = config.maxRetries;
  let rateLimitLeft = config.rateLimitMaxRetries;
  let rateLimitAttempt = 0;

  for (;;) {
    try {
      const response = await getClient().chat.completions.create(
        {
          model: config.model,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...(json ? { response_format: { type: "json_object" } } : {}),
        },
        { timeout: config.timeoutMs }
      );

      const content = response?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        throw new Error("Qwen returned an empty response");
      }
      return content.trim();
    } catch (err) {
      lastError = err;
      const { kind } = classifyQwenError(err);
      console.warn(`[${label}] attempt failed (${kind}): ${err?.message ?? err}`);

      // An auth failure won't fix itself on retry — fail fast and log loudly.
      if (kind === "auth") {
        console.error(
          `[${label}] AUTH ERROR — check QWEN_API_KEY / QWEN_BASE_URL. ${err?.message ?? err}`
        );
        break;
      }

      // Rate-limit (429) and transient overload (503) both back off and retry
      // out of the same generous budget, honoring any server-provided delay.
      if (kind === "rate_limit" || kind === "overloaded") {
        if (rateLimitLeft <= 0) break;
        rateLimitLeft -= 1;
        rateLimitAttempt += 1;
        const delay = retryDelayMsFor(
          err,
          rateLimitAttempt,
          config.rateLimitMaxDelayMs
        );
        console.warn(
          `[${label}] ${kind} — waiting ${Math.round(delay / 1000)}s then retrying (${rateLimitLeft} retries left).`
        );
        await sleep(delay);
        continue;
      }

      // timeout / upstream: small linear backoff.
      if (transientLeft <= 0) break;
      transientLeft -= 1;
      await sleep(750 * (config.maxRetries - transientLeft));
    }
  }

  const { statusCode, kind } = classifyQwenError(lastError);
  const message = lastError?.message ?? String(lastError);
  const readable =
    kind === "timeout"
      ? `Qwen call "${label}" timed out after ${config.timeoutMs}ms.`
      : kind === "auth"
        ? `Qwen authentication failed for call "${label}". Check QWEN_API_KEY.`
        : kind === "rate_limit"
          ? `Qwen call "${label}" was rate limited (429) and did not recover after ${config.rateLimitMaxRetries} retries: ${message}`
          : kind === "overloaded"
            ? `Qwen call "${label}" hit a transient overload (503) and did not recover after ${config.rateLimitMaxRetries} retries: ${message}`
            : `Qwen call "${label}" failed: ${message}`;
  throw new QwenError(readable, { statusCode, kind, cause: lastError });
}

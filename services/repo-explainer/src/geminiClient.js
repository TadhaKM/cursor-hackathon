import OpenAI from "openai";
import { config } from "./config.js";

// Typed error so the HTTP layer can map failures to clean status codes.
export class GeminiError extends Error {
  constructor(message, { statusCode = 502, kind = "upstream", cause } = {}) {
    super(message);
    this.name = "GeminiError";
    this.statusCode = statusCode;
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

// Map a raw SDK/network error to a (statusCode, kind) pair.
export function classifyGeminiError(err) {
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

  if (status === 429) return { statusCode: 429, kind: "rate_limit" };

  return { statusCode: 502, kind: "upstream" };
}

// Single OpenAI-compatible client pointed at Google AI Studio (Gemini). The
// SDK's built-in retries are disabled; we handle them ourselves so the
// semantics are explicit.
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

// How long to wait after a 429 before retrying — prefer the provider's
// Retry-After / "retry in Ns" hint, otherwise assume the per-minute quota
// bucket. Capped so a single call can't hang too long.
function rateLimitDelayMs(err) {
  const header =
    err?.response?.headers?.get?.("retry-after") ??
    err?.headers?.get?.("retry-after");
  let seconds = header ? Number(header) : NaN;
  if (!Number.isFinite(seconds)) {
    const m = String(err?.message ?? "").match(/retry in ([\d.]+)\s*s/i);
    if (m) seconds = Number(m[1]);
  }
  if (!Number.isFinite(seconds)) seconds = 30;
  return Math.min(Math.max(seconds, 5), 35) * 1000 + 500;
}

/**
 * Run a single chat completion against Gemini with an explicit timeout and
 * bounded, kind-aware retries:
 *   - 429 (rate limit): wait for the quota bucket to refill, then retry.
 *   - 503/502/500 (overload): short exponential backoff, then retry.
 *   - anything else: one generic retry.
 */
export async function chat({
  system,
  user,
  json = false,
  temperature = 0.4,
  label = "gemini-call",
}) {
  const genericAttempts = config.maxRetries + 1;
  let lastError;
  let genericAttempt = 0;
  let rateLimitRetries = 0;
  let overloadRetries = 0;
  const maxRateLimitRetries = 2;
  const maxOverloadRetries = 4;

  while (true) {
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
        throw new Error("Gemini returned an empty response");
      }
      return content.trim();
    } catch (err) {
      lastError = err;
      const status = err?.status ?? err?.response?.status;
      const { kind } = classifyGeminiError(err);

      // Auth won't fix itself on retry — fail fast and log loudly.
      if (kind === "auth") {
        console.error(
          `[${label}] AUTH ERROR from Gemini — check GEMINI_API_KEY / GEMINI_BASE_URL. ${err?.message ?? err}`
        );
        break;
      }

      // Rate limited: wait for the quota bucket to refill, then retry.
      if (status === 429 && rateLimitRetries < maxRateLimitRetries) {
        rateLimitRetries++;
        const waitMs = rateLimitDelayMs(err);
        console.warn(
          `[${label}] rate limited (429) — waiting ${Math.round(
            waitMs / 1000
          )}s then retrying (${rateLimitRetries}/${maxRateLimitRetries})…`
        );
        await sleep(waitMs);
        continue;
      }

      // Transient overload: short exponential backoff, then retry.
      if (
        (status === 503 || status === 502 || status === 500) &&
        overloadRetries < maxOverloadRetries
      ) {
        overloadRetries++;
        const waitMs = Math.min(1500 * 2 ** (overloadRetries - 1), 12000);
        console.warn(
          `[${label}] Gemini overloaded (${status}) — retrying in ${Math.round(
            waitMs / 1000
          )}s (${overloadRetries}/${maxOverloadRetries})…`
        );
        await sleep(waitMs);
        continue;
      }

      genericAttempt++;
      console.warn(
        `[${label}] attempt ${genericAttempt} failed: ${err?.message ?? err}`
      );
      if (genericAttempt >= genericAttempts) break;
      await sleep(750 * genericAttempt);
    }
  }

  const { statusCode, kind } = classifyGeminiError(lastError);
  const message = lastError?.message ?? String(lastError);
  const readable =
    kind === "timeout"
      ? `Gemini call "${label}" timed out after ${config.timeoutMs}ms.`
      : kind === "auth"
        ? `Gemini authentication failed for call "${label}". Check GEMINI_API_KEY.`
        : kind === "rate_limit"
          ? `Gemini call "${label}" is rate limited (429) — free-tier quota exhausted. Wait a minute or use a key with more quota.`
          : `Gemini call "${label}" failed: ${message}`;
  throw new GeminiError(readable, { statusCode, kind, cause: lastError });
}

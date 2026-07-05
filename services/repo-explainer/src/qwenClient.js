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

  return { statusCode: 502, kind: "upstream" };
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
  const attempts = config.maxRetries + 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
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
      const isLast = attempt === attempts;
      console.warn(
        `[${label}] attempt ${attempt}/${attempts} failed: ${err?.message ?? err}`
      );
      // An auth failure won't fix itself on retry — fail fast and log loudly.
      const { kind } = classifyQwenError(err);
      if (kind === "auth") {
        console.error(
          `[${label}] AUTH ERROR from Qwen — check QWEN_API_KEY / QWEN_BASE_URL. ${err?.message ?? err}`
        );
        break;
      }
      if (isLast) break;
      // Short linear backoff before the single retry.
      await sleep(750 * attempt);
    }
  }

  const { statusCode, kind } = classifyQwenError(lastError);
  const message = lastError?.message ?? String(lastError);
  const readable =
    kind === "timeout"
      ? `Qwen call "${label}" timed out after ${config.timeoutMs}ms (${attempts} attempt(s)).`
      : kind === "auth"
        ? `Qwen authentication failed for call "${label}". Check QWEN_API_KEY.`
        : `Qwen call "${label}" failed after ${attempts} attempt(s): ${message}`;
  throw new QwenError(readable, { statusCode, kind, cause: lastError });
}

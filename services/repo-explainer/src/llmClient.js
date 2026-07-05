import OpenAI from "openai";
import { config } from "./config.js";

// Typed error so the HTTP layer can map failures to clean status codes.
export class LlmError extends Error {
  constructor(message, { statusCode = 502, kind = "upstream", cause } = {}) {
    super(message);
    this.name = "LlmError";
    this.statusCode = statusCode;
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

/** @deprecated use classifyLlmError */
export const classifyQwenError = classifyLlmError;

// Map a raw SDK/network error to a (statusCode, kind) pair.
export function classifyLlmError(err) {
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
    status === 403 ||
    status === 400 && msg.includes("api key");
  if (isAuth) return { statusCode: 500, kind: "auth" };

  return { statusCode: 502, kind: "upstream" };
}

// OpenAI-compatible client pointed at Google AI Studio (Gemini).
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
 * Run a single chat completion with an explicit timeout and bounded retries.
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
  label = "llm-call",
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
        throw new Error("Model returned an empty response");
      }
      return content.trim();
    } catch (err) {
      lastError = err;
      const isLast = attempt === attempts;
      console.warn(
        `[${label}] attempt ${attempt}/${attempts} failed: ${err?.message ?? err}`
      );
      const { kind } = classifyLlmError(err);
      if (kind === "auth") {
        console.error(
          `[${label}] AUTH ERROR — check GEMINI_API_KEY. ${err?.message ?? err}`
        );
        break;
      }
      if (isLast) break;
      await sleep(750 * attempt);
    }
  }

  const { statusCode, kind } = classifyLlmError(lastError);
  const message = lastError?.message ?? String(lastError);
  const readable =
    kind === "timeout"
      ? `LLM call "${label}" timed out after ${config.timeoutMs}ms (${attempts} attempt(s)).`
      : kind === "auth"
        ? `LLM authentication failed for call "${label}". Check GEMINI_API_KEY.`
        : `LLM call "${label}" failed after ${attempts} attempt(s): ${message}`;
  throw new LlmError(readable, { statusCode, kind, cause: lastError });
}

import OpenAI from "openai";
import { config } from "./config.js";

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
      if (isLast) break;
      // Short linear backoff before the single retry.
      await sleep(750 * attempt);
    }
  }

  const message = lastError?.message ?? String(lastError);
  throw new Error(`Qwen call "${label}" failed after ${attempts} attempt(s): ${message}`);
}

// Chat completion for the RAG /chat endpoint, calling OpenRouter's
// OpenAI-compatible /chat/completions directly (fetch, not the SDK) so we get
// exact control over the headers, timeout, 429 backoff, and model fallback the
// chat feature needs — separate from the /explain LLM calls.

import { config } from "./config.js";

export class ChatError extends Error {
  constructor(message, { statusCode = 502, kind = "upstream" } = {}) {
    super(message);
    this.name = "ChatError";
    this.statusCode = statusCode;
    this.kind = kind;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A model-availability error (free models get deprecated often) — worth
// retrying against the configured fallback model rather than failing.
function isModelUnavailable(status, data) {
  const msg = String(data?.error?.message ?? "").toLowerCase();
  return (
    status === 404 ||
    msg.includes("no endpoints") ||
    msg.includes("not a valid model") ||
    msg.includes("no allowed providers") ||
    msg.includes("model not found") ||
    msg.includes("is not available")
  );
}

async function callModel(model, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.chatTimeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        // OpenRouter uses these for dashboard attribution (optional but good).
        "HTTP-Referer": config.appReferer,
        "X-Title": config.appTitle,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 700, // 2-4 sentence answers; also keeps under free-tier caps
      }),
      signal: controller.signal,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* leave data = {} */
    }
    return { res, data };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new ChatError(
        `Chat timed out after ${config.chatTimeoutMs / 1000}s.`,
        { statusCode: 504, kind: "timeout" }
      );
    }
    throw new ChatError(`Chat request failed: ${err?.message ?? err}`, {
      statusCode: 502,
      kind: "upstream",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a chat completion with the configured chat model, retrying once on 429
 * and falling back to config.chatFallbackModel if the primary is unavailable.
 * @returns {Promise<{ answer: string, model: string }>}
 */
export async function chatComplete(messages) {
  const models = [config.chatModel];
  if (config.chatFallbackModel && config.chatFallbackModel !== config.chatModel) {
    models.push(config.chatFallbackModel);
  }

  let lastError = null;

  for (const model of models) {
    // Up to 2 attempts per model, purely to absorb a single 429.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { res, data } = await callModel(model, messages);

      if (res.ok) {
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return { answer: text, model };
        lastError = new ChatError("Chat model returned an empty response.", {
          statusCode: 502,
          kind: "upstream",
        });
        break; // try the next model, if any
      }

      if (res.status === 429) {
        // Retry once after a short backoff, then fail gracefully.
        if (attempt === 0) {
          console.warn(`[chat] 429 from ${model} — backing off 1.5s and retrying`);
          await sleep(1500);
          continue;
        }
        throw new ChatError("Chat is busy right now, try again in a moment.", {
          statusCode: 429,
          kind: "rate_limit",
        });
      }

      if (isModelUnavailable(res.status, data)) {
        console.warn(
          `[chat] model '${model}' unavailable (${res.status}) — trying fallback if set`
        );
        lastError = new ChatError(
          `Chat model '${model}' is unavailable.`,
          { statusCode: 502, kind: "upstream" }
        );
        break; // try the next (fallback) model
      }

      // Any other non-OK status: don't spin, surface it.
      throw new ChatError(
        `Chat model error (${res.status}): ${data?.error?.message ?? "unknown"}`,
        { statusCode: 502, kind: "upstream" }
      );
    }
  }

  throw (
    lastError ??
    new ChatError("Chat failed — no model produced a response.", {
      statusCode: 502,
      kind: "upstream",
    })
  );
}

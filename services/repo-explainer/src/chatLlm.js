// Chat completion for the RAG /chat endpoint.
//
// Prefers Anthropic (Claude) when ANTHROPIC_API_KEY is set — free-tier
// OpenRouter models are unreliable during a hackathon (constant 429s and
// week-to-week deprecations), whereas Claude gives grounded, consistent
// answers. Falls back to OpenRouter's OpenAI-compatible endpoint otherwise.
//
// Both paths cap the wait (config.chatTimeoutMs, default 20s), retry once on a
// 429 after a short backoff, then fail with a friendly "busy" message rather
// than a raw error. This is kept separate from the /explain LLM calls.

import Anthropic from "@anthropic-ai/sdk";
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

// Which chat model string /chat will report in its response meta.
export function activeChatModel() {
  return config.anthropicApiKey ? config.anthropicModel : config.chatModel;
}

/**
 * Run a chat completion. Dispatches to Claude or OpenRouter based on config.
 * @param {{role:"system"|"user"|"assistant", content:string}[]} messages
 * @returns {Promise<{ answer: string, model: string }>}
 */
export async function chatComplete(messages) {
  if (config.anthropicApiKey) return chatViaAnthropic(messages);
  return chatViaOpenRouter(messages);
}

// --- Anthropic (Claude) -----------------------------------------------------

let anthropic = null;
function anthropicClient() {
  if (!anthropic) {
    // We handle our own 429 backoff + timeout, so disable the SDK's retries.
    anthropic = new Anthropic({
      apiKey: config.anthropicApiKey,
      timeout: config.chatTimeoutMs,
      maxRetries: 0,
    });
  }
  return anthropic;
}

// Anthropic takes the system prompt as a top-level param (not a message) and
// only user/assistant turns in `messages`.
function splitSystem(messages) {
  const system = messages
    .filter((m) => m.role === "system" && m.content)
    .map((m) => String(m.content))
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system" && m.content)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content),
    }));
  return { system, rest };
}

async function chatViaAnthropic(messages) {
  const { system, rest } = splitSystem(messages);
  const model = config.anthropicModel;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await anthropicClient().messages.create({
        model,
        max_tokens: config.chatMaxTokens,
        // Note: newer Claude models (e.g. claude-opus-4-8) reject `temperature`,
        // so we don't send it — the default sampling is fine for grounded QA.
        system,
        messages: rest.length ? rest : [{ role: "user", content: "(no question)" }],
      });
      const text = (res.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (text) return { answer: text, model };
      throw new ChatError("Chat model returned an empty response.", {
        statusCode: 502,
        kind: "upstream",
      });
    } catch (err) {
      if (err instanceof ChatError) throw err;
      const status = err?.status ?? err?.response?.status;

      if (status === 429) {
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

      if (
        err instanceof Anthropic.APIConnectionTimeoutError ||
        String(err?.name ?? "").toLowerCase().includes("timeout")
      ) {
        throw new ChatError(
          `Chat timed out after ${config.chatTimeoutMs / 1000}s.`,
          { statusCode: 504, kind: "timeout" }
        );
      }

      if (status === 401 || status === 403) {
        throw new ChatError("Chat auth failed — check ANTHROPIC_API_KEY.", {
          statusCode: 500,
          kind: "auth",
        });
      }

      throw new ChatError(`Chat model error: ${err?.message ?? err}`, {
        statusCode: 502,
        kind: "upstream",
      });
    }
  }

  throw new ChatError("Chat failed — no response.", {
    statusCode: 502,
    kind: "upstream",
  });
}

// --- OpenRouter fallback (OpenAI-compatible /chat/completions) ---------------

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
        max_tokens: config.chatMaxTokens,
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

async function chatViaOpenRouter(messages) {
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
        lastError = new ChatError(`Chat model '${model}' is unavailable.`, {
          statusCode: 502,
          kind: "upstream",
        });
        break; // try the next (fallback) model
      }

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

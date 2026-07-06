// Netlify Function port of the chat proxy (api/chat.ts is Vercel-only).
// Grounds answers in the repo's ingested files (TF-IDF over key files) and
// calls an LLM. Prefers Anthropic Claude when ANTHROPIC_API_KEY is set (matches
// the repo-explainer's /chat); otherwise falls back to an OpenAI-compatible
// provider (OpenRouter/Gemini). Uses only Node built-ins (native fetch) — no deps.

// Anthropic (Claude) — preferred.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// OpenAI-compatible fallback (OpenRouter, or legacy GEMINI_* names).
const OAI_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
const BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL =
  process.env.OPENROUTER_MODEL ||
  process.env.GEMINI_MODEL ||
  "google/gemini-2.5-flash";

const API_KEY = ANTHROPIC_API_KEY || OAI_API_KEY;

const MAX_CONTEXT_CHARS = 48_000;
const TOP_FILES = 6;
const MAX_FILE_CHARS = 8_000;

const STOPWORDS = new Set(
  "the a an and or of to in is are be for on with as at by from this that it its into how what where why when does do can i you we they will would should could".split(
    " "
  )
);

function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

function scoreFile(content, qTokens) {
  let score = 0;
  for (const t of tokenize(content)) if (qTokens.has(t)) score += 1;
  return score;
}

function selectKeyFiles(files, question) {
  if (!files || files.length === 0) return [];
  const q = new Set(tokenize(question));
  return [...files]
    .map((f) => ({ file: f, score: scoreFile(f.content ?? "", q) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_FILES)
    .map(({ file }) => ({
      path: file.path,
      content: String(file.content ?? "").slice(0, MAX_FILE_CHARS),
    }));
}

function buildRepoContext(ing, question) {
  const parts = [];
  const sources = [];
  parts.push(`Repository: ${ing.repo_url}`);
  if (ing.readme) parts.push(`## README\n${String(ing.readme).slice(0, 12_000)}`);
  if (ing.file_tree)
    parts.push(`## File tree\n${String(ing.file_tree).slice(0, 6_000)}`);
  if (ing.package_manifest)
    parts.push(
      `## Package manifest\n${String(ing.package_manifest).slice(0, 4_000)}`
    );
  if (Array.isArray(ing.recent_commits) && ing.recent_commits.length) {
    const commits = ing.recent_commits
      .slice(0, 8)
      .map((c) => `- ${c.date}: ${c.message}`)
      .join("\n");
    parts.push(`## Recent commits\n${commits}`);
  }
  for (const file of selectKeyFiles(ing.key_files ?? [], question)) {
    parts.push(`## File: ${file.path}\n${file.content}`);
    sources.push(file.path);
  }
  let text = parts.join("\n\n");
  if (text.length > MAX_CONTEXT_CHARS)
    text = text.slice(0, MAX_CONTEXT_CHARS) + "\n\n[context truncated]";
  return { text, sources };
}

function buildToolContext(ing) {
  return {
    text: String(ing.readme ?? "").slice(0, MAX_CONTEXT_CHARS),
    sources: ["tool-docs"],
  };
}

function systemPrompt(contextType) {
  if (contextType === "tool") {
    return [
      "You are a helpful assistant for the Redio onboarding tool.",
      "Answer questions about how the tool works using ONLY the documentation provided.",
      "Be concise, accurate, and friendly. If the docs do not cover something, say so.",
      "Do not invent features or backend details not mentioned in the docs.",
    ].join(" ");
  }
  return [
    "You are a senior engineer helping a new teammate understand a codebase.",
    "Answer questions using ONLY the repository context provided (README, file tree, key files, manifest, commits).",
    "Reference specific file paths when relevant. Be concise and practical.",
    "If the context does not contain enough information, say what is missing rather than guessing.",
  ].join(" ");
}

async function callLLM(system, userPrompt) {
  if (ANTHROPIC_API_KEY) return callClaude(system, userPrompt);
  return callOpenAICompatible(system, userPrompt);
}

// Anthropic REST — no temperature (newer Claude models reject it).
async function callClaude(system, userPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Claude error (${res.status})`);
  }
  const text = (data?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude returned an empty response");
  return text;
}

async function callOpenAICompatible(system, userPrompt) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `LLM error (${res.status})`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("LLM returned an empty response");
  return text.trim();
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: CORS,
  body: JSON.stringify(obj),
});

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!API_KEY)
    return json(500, {
      error: "No chat API key configured — set ANTHROPIC_API_KEY (or OPENROUTER_API_KEY).",
    });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Request body must be valid JSON" });
  }

  const { context_type, question, ingestion } = body;
  if (context_type !== "repo" && context_type !== "tool")
    return json(400, { error: "context_type must be 'repo' or 'tool'" });
  if (!question || typeof question !== "string" || !question.trim())
    return json(400, { error: "question is required" });
  if (!ingestion || typeof ingestion !== "object")
    return json(400, { error: "ingestion is required" });

  try {
    const { text: context, sources } =
      context_type === "tool"
        ? buildToolContext(ingestion)
        : buildRepoContext(ingestion, question.trim());
    const answer = await callLLM(
      systemPrompt(context_type),
      `Context:\n${context}\n\nQuestion: ${question.trim()}`
    );
    return json(200, { answer, sources });
  } catch (err) {
    return json(502, { error: err?.message ?? "Chat request failed" });
  }
};

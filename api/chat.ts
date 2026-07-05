import type { VercelRequest, VercelResponse } from "@vercel/node";

interface KeyFile {
  path: string;
  content: string;
}

interface Ingestion {
  repo_url: string;
  file_tree: string;
  readme: string;
  key_files: KeyFile[];
  recent_commits: { message: string; date: string }[];
  package_manifest: string;
}

interface ChatRequestBody {
  context_type: "repo" | "tool";
  question: string;
  ingestion: Ingestion;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

const MAX_CONTEXT_CHARS = 48_000;
const TOP_FILES = 6;
const MAX_FILE_CHARS = 8_000;

const STOPWORDS = new Set(
  "the a an and or of to in is are be for on with as at by from this that it its into how what where why when does do can i you we they will would should could".split(
    " "
  )
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

function scoreFile(content: string, questionTokens: Set<string>): number {
  const tokens = tokenize(content);
  let score = 0;
  for (const t of tokens) {
    if (questionTokens.has(t)) score += 1;
  }
  return score;
}

function selectKeyFiles(files: KeyFile[], question: string): KeyFile[] {
  if (files.length === 0) return [];
  const qTokens = new Set(tokenize(question));
  return [...files]
    .map((f) => ({ file: f, score: scoreFile(f.content, qTokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_FILES)
    .map(({ file }) => ({
      path: file.path,
      content: file.content.slice(0, MAX_FILE_CHARS),
    }));
}

function buildRepoContext(ingestion: Ingestion, question: string): { text: string; sources: string[] } {
  const parts: string[] = [];
  const sources: string[] = [];

  parts.push(`Repository: ${ingestion.repo_url}`);

  if (ingestion.readme) {
    parts.push(`## README\n${ingestion.readme.slice(0, 12_000)}`);
  }

  if (ingestion.file_tree) {
    parts.push(`## File tree\n${ingestion.file_tree.slice(0, 6_000)}`);
  }

  if (ingestion.package_manifest) {
    parts.push(`## Package manifest\n${ingestion.package_manifest.slice(0, 4_000)}`);
  }

  if (ingestion.recent_commits.length > 0) {
    const commits = ingestion.recent_commits
      .slice(0, 8)
      .map((c) => `- ${c.date}: ${c.message}`)
      .join("\n");
    parts.push(`## Recent commits\n${commits}`);
  }

  const selected = selectKeyFiles(ingestion.key_files ?? [], question);
  for (const file of selected) {
    parts.push(`## File: ${file.path}\n${file.content}`);
    sources.push(file.path);
  }

  let text = parts.join("\n\n");
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS) + "\n\n[context truncated]";
  }

  return { text, sources };
}

function buildToolContext(ingestion: Ingestion): { text: string; sources: string[] } {
  const text = ingestion.readme.slice(0, MAX_CONTEXT_CHARS);
  return { text, sources: ["tool-docs"] };
}

function systemPrompt(contextType: "repo" | "tool"): string {
  if (contextType === "tool") {
    return [
      "You are a helpful assistant for the repo-to-video onboarding tool.",
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

async function callGemini(system: string, userPrompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
      },
    }),
  });

  const data = (await res.json()) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  if (!res.ok) {
    throw new Error(data.error?.message ?? `Gemini API error (${res.status})`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text.trim();
}

function setCorsHeaders(req: VercelRequest, res: VercelResponse): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";

  if (ALLOWED_ORIGIN) {
    if (origin && origin !== ALLOWED_ORIGIN) {
      return false;
    }
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  } else if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!setCorsHeaders(req, res)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not configured on the server",
    });
  }

  const body = req.body as ChatRequestBody | undefined;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  const { context_type, question, ingestion } = body;

  if (context_type !== "repo" && context_type !== "tool") {
    return res.status(400).json({ error: "context_type must be 'repo' or 'tool'" });
  }

  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  if (!ingestion || typeof ingestion !== "object") {
    return res.status(400).json({ error: "ingestion is required" });
  }

  try {
    const { text: context, sources } =
      context_type === "tool"
        ? buildToolContext(ingestion)
        : buildRepoContext(ingestion, question.trim());

    const userPrompt = `Context:\n${context}\n\nQuestion: ${question.trim()}`;
    const answer = await callGemini(systemPrompt(context_type), userPrompt);

    return res.status(200).json({ answer, sources });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat request failed";
    return res.status(502).json({ error: message });
  }
}

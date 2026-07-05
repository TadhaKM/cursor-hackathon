// api.ts
// Real pipeline wiring, matching the team's locked data contract:
//   POST {INGEST}/ingest    -> IngestResult
//   POST {EXPLAIN}/explain  -> ExplainResult
//   POST {RENDER}/render    -> kicks off async video jobs
//   GET  {RENDER}/render/:job_id  -> poll until ready/partial/failed
//
// Base URLs come from Vite env vars, set per-environment in Render:
//   VITE_INGEST_URL, VITE_EXPLAIN_URL, VITE_RENDER_URL
//
// If those aren't set (e.g. running locally before teammates deploy),
// falls back to a mocked pipeline so the UI is always testable standalone.

export type Persona = "new_grad" | "senior_engineer";
export type StageId = "ingest" | "explain" | "render";

export interface StageEvent {
  stage: StageId;
  ok: boolean;
  detail?: string;
}

export interface IngestResult {
  repo_url: string;
  file_tree: string;
  readme: string;
  key_files: { path: string; content: string }[];
  recent_commits: { message: string; date: string }[];
  package_manifest: string;
}

export interface ExplainSection {
  title: string;
  script: string;
  // Short (5-8 word) label summarizing the section, e.g. "Handles user
  // login and sessions" — for a caption near the diagram, not the video.
  caption?: string | null;
  // Mermaid diagram node ids (from mermaid_diagram) this section discusses,
  // e.g. ["B"] for a node declared as `B[Auth Module]` — used to highlight
  // the relevant node(s) while this section plays. Empty for general
  // sections not tied to a specific node.
  node_ids?: string[];
}

export interface ExplainResult {
  architecture_summary: string;
  narration_script: { sections: ExplainSection[] };
  mermaid_diagram: string | null;
}

export interface VideoSection {
  title: string;
  video_url: string | null;
  // Matches Person 3's per-section VideoStatus (models.py): the backend emits
  // "completed", not "ready" — "ready" is only the job-level status.
  status: "processing" | "completed" | "failed";
}

export interface RenderResult {
  status: "processing" | "ready" | "partial" | "failed";
  job_id?: string;
  videos: VideoSection[];
  diagram_image_url?: string | null;
}

export interface DiagramHighlight {
  section_index: number;
  node_id: string;
  caption?: string;
}

export interface PipelineResult {
  repo: string;
  architectureSummary: string;
  sections: ExplainSection[];
  videos: VideoSection[];
  diagramImageUrl: string | null;
  // Raw mermaid source (not the rendered PNG) — needed to render the
  // diagram client-side so individual nodes can be highlighted per section.
  mermaidDiagram: string | null;
  // Backend-provided node highlights (from repo-explainer's per-section
  // node_ids, see ExplainSection) — takes priority over DiagramPanel's
  // client-side title-matching heuristic in resolveDiagramHighlights()
  // when present, since this is grounded in the actual narration script
  // rather than a label-text guess.
  diagramHighlights?: DiagramHighlight[];
  ingestion: IngestResult;
}

// ---------------------------------------------------------------------
// Diff mode — narrate what changed between two refs instead of a full repo
// walkthrough:
//   POST {INGEST}/diff          -> DiffResult
//   POST {EXPLAIN}/explain-diff -> ExplainDiffResult (always exactly 1 section)
//   POST {RENDER}/render        -> same render/poll path as the main pipeline
// ---------------------------------------------------------------------

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface DiffResult {
  repo_url: string;
  base_ref: string;
  head_ref: string;
  total_commits: number;
  commits: { message: string; date: string }[];
  files: DiffFile[];
  meta: {
    owner: string;
    repo: string;
    total_files_changed: number;
    files_included: number;
    truncated: boolean;
  };
}

export interface ExplainDiffResult {
  narration_script: { sections: ExplainSection[] };
}

export interface DiffPipelineResult {
  repo: string;
  baseRef: string;
  headRef: string;
  section: ExplainSection;
  video: VideoSection;
  filesChanged: number;
  totalFilesChanged: number;
}

const INGEST_URL = import.meta.env.VITE_INGEST_URL as string | undefined;
const EXPLAIN_URL = import.meta.env.VITE_EXPLAIN_URL as string | undefined;
const RENDER_URL = import.meta.env.VITE_RENDER_URL as string | undefined;

const USING_REAL_BACKEND = Boolean(INGEST_URL && EXPLAIN_URL && RENDER_URL);

export function backendMode(): "live" | "mock" {
  return USING_REAL_BACKEND ? "live" : "mock";
}

// ---------------------------------------------------------------------
// Chat — proxied through a Vercel serverless function (api/chat.ts) so
// GEMINI_API_KEY never ships to the browser:
//   POST {VITE_CHAT_URL}   Body: { context_type, question, ingestion }
//   -> { answer: string, sources: string[] }
// Pipeline /explain still uses VITE_EXPLAIN_URL (Person 2's Gemini service).
// ---------------------------------------------------------------------

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined;

export interface ChatAnswer {
  answer: string;
  sources: string[];
}

export interface ChatTurn {
  question: string;
  answer: string;
}

export type ChatBackendPreference = "auto" | "explain" | "gemini";

export class ChatHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ChatHttpError";
    this.status = status;
  }
}

export function chatMode(): "live" | "mock" {
  return CHAT_URL || EXPLAIN_URL ? "live" : "mock";
}

export function chatBackend(): "gemini" | "explain" | "mock" {
  if (CHAT_URL) return "gemini";
  if (EXPLAIN_URL) return "explain";
  return "mock";
}

// Synthetic "ingestion" payload for the tool-level FAQ assistant (no repo
// has been processed yet, or the question isn't about a specific repo).
export const TOOL_DOCS: IngestResult = {
  repo_url: "redio",
  file_tree: "",
  readme: [
    "# Redio",
    "",
    "A tool that turns a public GitHub repo into a short onboarding walkthrough video.",
    "",
    "## Pipeline",
    "1. Ingest — reads the file tree, README, key files, package manifest, and recent commits from the pasted GitHub URL. Public repos only; private repos need OAuth, which isn't wired up.",
    "2. Explain — an LLM (Gemini) turns that structure into an architecture summary and a spoken narration script, split into sections, plus an optional mermaid diagram.",
    "3. Render — each section becomes its own short video via HeyGen, so nobody sits through one long video to find the part they need.",
    "",
    "## Modes",
    "- New grad persona: explains *why* patterns exist and defines jargon.",
    "- Senior engineer persona: skips the basics, flags what's nonstandard.",
    "- Mock data mode: runs automatically when the backend URLs aren't configured, so the UI is always testable. A pill in the top bar shows whether you're in mock or live mode.",
    "",
    "## Timing",
    "Mock mode finishes in about 5 seconds. Against the real backend, rendering takes as long as HeyGen needs per section — usually a minute or two each.",
    "",
    "## Limitations",
    "If a stage fails, the app shows exactly which one and lets you retry without redoing earlier stages. Only public GitHub repos are supported right now.",
  ].join("\n"),
  key_files: [],
  recent_commits: [],
  package_manifest: "",
};

function buildQuestionWithHistory(question: string, history: ChatTurn[]): string {
  if (history.length === 0) return question;
  const prior = history
    .map((t) => `User: ${t.question}\nAssistant: ${t.answer}`)
    .join("\n\n");
  return `Prior conversation:\n${prior}\n\nFollow-up question: ${question}`;
}

async function parseChatResponse(res: Response): Promise<ChatAnswer> {
  if (!res.ok) {
    const text = await safeText(res);
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      detail = parsed.error ?? text;
    } catch {
      // keep raw text
    }
    throw new ChatHttpError(detail || `Chat request failed (${res.status})`, res.status);
  }

  const data = (await res.json()) as { answer?: string; sources?: string[] };
  if (!data.answer) {
    throw new Error("Chat endpoint returned an empty answer");
  }
  return { answer: data.answer, sources: data.sources ?? [] };
}

export async function askQuestion(
  ingestion: IngestResult,
  question: string,
  signal?: AbortSignal,
  contextType: "repo" | "tool" = "repo",
  options?: { history?: ChatTurn[]; backend?: ChatBackendPreference }
): Promise<ChatAnswer> {
  const history = options?.history ?? [];
  const backend = options?.backend ?? "auto";
  const enrichedQuestion = buildQuestionWithHistory(question, history);

  // Result-screen repo chat prefers Person 2's /chat when EXPLAIN_URL is set.
  if (backend === "explain" && EXPLAIN_URL && contextType === "repo") {
    const res = await fetch(`${EXPLAIN_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ingestion, question: enrichedQuestion }),
      signal,
    });
    return parseChatResponse(res);
  }

  if (backend !== "explain" && CHAT_URL) {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context_type: contextType,
        question: enrichedQuestion,
        ingestion,
      }),
      signal,
    });
    return parseChatResponse(res);
  }

  // Person 2's RAG chat — same ingestion payload, Gemini + TF-IDF over key files
  if (EXPLAIN_URL && contextType === "repo") {
    const res = await fetch(`${EXPLAIN_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ingestion, question: enrichedQuestion }),
      signal,
    });
    return parseChatResponse(res);
  }

  return mockAnswer(ingestion, question);
}

function mockAnswer(_ingestion: IngestResult, question: string): Promise<ChatAnswer> {
  return Promise.resolve({
    answer:
      `Chat is in mock mode — set \`VITE_EXPLAIN_URL\` (Person 2's Gemini RAG) or \`VITE_CHAT_URL\` (Gemini proxy).\n\n` +
      `You asked: "${question}"`,
    sources: [],
  });
}

// Bridges repo-explainer's per-section node_ids (grounded in the actual
// narration, via a dedicated Gemini call) into DiagramPanel's
// DiagramHighlight[] shape, which otherwise only ever gets populated by
// resolveDiagramHighlights()'s client-side title-matching heuristic.
// DiagramHighlight is one node per section; a section with multiple
// node_ids just contributes its first (the primary node it discusses).
function sectionsToDiagramHighlights(sections: ExplainSection[]): DiagramHighlight[] {
  const highlights: DiagramHighlight[] = [];
  sections.forEach((s, i) => {
    const nodeId = s.node_ids?.[0];
    if (!nodeId) return;
    highlights.push({ section_index: i, node_id: nodeId, caption: s.caption ?? s.title });
  });
  return highlights;
}

export async function runPipeline(
  repoUrl: string,
  persona: Persona,
  onStage: (e: StageEvent) => void,
  signal?: AbortSignal
): Promise<PipelineResult> {
  if (!USING_REAL_BACKEND) {
    return runMockPipeline(repoUrl, onStage, signal);
  }

  // 1. Ingest
  const ingestRes = await postJSON<IngestResult>(
    `${INGEST_URL}/ingest`,
    { repo_url: repoUrl },
    signal
  );
  onStage({ stage: "ingest", ok: true });

  // 2. Explain
  const explainRes = await postJSON<ExplainResult>(
    `${EXPLAIN_URL}/explain`,
    { ...ingestRes, persona },
    signal
  );
  onStage({ stage: "explain", ok: true });

  // 3. Render — kick off async job, then poll. Forward the mermaid diagram so
  // Person 3 can render it to an image (the UI shows diagram_image_url).
  const kickoff = await postJSON<RenderResult>(
    `${RENDER_URL}/render`,
    {
      sections: explainRes.narration_script.sections,
      mermaid_diagram: explainRes.mermaid_diagram,
    },
    signal
  );

  const final = await pollRender(kickoff, signal);

  if (final.status === "failed") {
    onStage({ stage: "render", ok: false });
    throw new Error("Video rendering failed");
  }
  onStage({ stage: "render", ok: true });

  return {
    repo: repoUrl.replace(/\/$/, "").split("/").slice(-2).join("/") || repoUrl,
    architectureSummary: explainRes.architecture_summary,
    sections: explainRes.narration_script.sections,
    videos: final.videos,
    diagramImageUrl: final.diagram_image_url ?? null,
    mermaidDiagram: explainRes.mermaid_diagram,
    diagramHighlights: sectionsToDiagramHighlights(explainRes.narration_script.sections),
    ingestion: ingestRes,
  };
}

export async function runDiffPipeline(
  repoUrl: string,
  baseRef: string,
  headRef: string,
  onStage: (e: StageEvent) => void,
  signal?: AbortSignal
): Promise<DiffPipelineResult> {
  if (!USING_REAL_BACKEND) {
    return runMockDiffPipeline(repoUrl, baseRef, headRef, onStage, signal);
  }

  // 1. Diff — reuses the "ingest" stage slot, same UI progress step.
  const diffRes = await postJSON<DiffResult>(
    `${INGEST_URL}/diff`,
    { repo_url: repoUrl, base_ref: baseRef, head_ref: headRef },
    signal
  );
  onStage({ stage: "ingest", ok: true });

  // 2. Explain the diff — always exactly one section (see diffExplain.js).
  const explainRes = await postJSON<ExplainDiffResult>(
    `${EXPLAIN_URL}/explain-diff`,
    diffRes,
    signal
  );
  onStage({ stage: "explain", ok: true });

  const section = explainRes.narration_script.sections[0];
  if (!section) {
    onStage({ stage: "explain", ok: false });
    throw new Error("Diff narration returned no section");
  }

  // 3. Render — same single render/poll path as the main pipeline, just one
  // section and no diagram.
  const kickoff = await postJSON<RenderResult>(
    `${RENDER_URL}/render`,
    { sections: [section] },
    signal
  );

  const final = await pollRender(kickoff, signal);

  if (final.status === "failed" || !final.videos[0]) {
    onStage({ stage: "render", ok: false });
    throw new Error("Video rendering failed");
  }
  onStage({ stage: "render", ok: true });

  return {
    repo: repoUrl.replace(/\/$/, "").split("/").slice(-2).join("/") || repoUrl,
    baseRef,
    headRef,
    section,
    video: final.videos[0],
    filesChanged: diffRes.meta.files_included,
    totalFilesChanged: diffRes.meta.total_files_changed,
  };
}

async function pollRender(
  initial: RenderResult,
  signal?: AbortSignal
): Promise<RenderResult> {
  let current = initial;
  const jobId = initial.job_id;

  // If the backend resolved synchronously, nothing to poll.
  if (!jobId || current.status === "ready" || current.status === "failed") {
    return current;
  }

  const start = Date.now();
  const maxWaitMs = 5 * 60 * 1000; // 5 min ceiling, matches Person 3's spec
  let delay = 5000;

  while (Date.now() - start < maxWaitMs) {
    await wait(delay, signal);
    current = await getJSON<RenderResult>(
      `${RENDER_URL}/render/${jobId}`,
      signal
    );
    if (current.status === "ready" || current.status === "failed") {
      return current;
    }
    delay = 15000; // back off after the first ~30s, per Person 3's spec
  }

  return { ...current, status: "failed" };
}

async function postJSON<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return url;
      }
    })();
    throw new Error(
      `Can't reach ${origin} — the backend isn't running or blocked the request. ` +
        `For local demo without services, remove VITE_INGEST_URL / VITE_EXPLAIN_URL / VITE_RENDER_URL from .env.local (mock mode).`
    );
  }
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`${url} -> ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`Can't reach the render service — is it running on ${RENDER_URL}?`);
  }
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`${url} -> ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

async function safeText(res: Response) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

// ---------------------------------------------------------------------
// Mock fallback — used automatically when VITE_INGEST_URL etc. aren't set,
// so the UI is fully testable before any real backend exists.
// ---------------------------------------------------------------------

const MOCK_MERMAID_DIAGRAM = `graph TD
  A[Client] --> B[API Layer]
  B --> C[Auth Module]
  B --> D[Core Logic]
  D --> E[(Database)]`;

const MOCK_SECTIONS: ExplainSection[] = [
  { title: "Overview", script: "This project is a modular service with a clear entry point and a small set of core routes.", caption: null, node_ids: [] },
  { title: "Auth Module", script: "Authentication is handled in a dedicated module, separating login and token logic from the rest of the app.", caption: "Handles login and session tokens", node_ids: ["C"] },
  { title: "API Layer", script: "The API layer routes requests into core logic and talks to the database through a thin data-access layer.", caption: "Routes requests to core logic", node_ids: ["B", "D"] },
];

async function runMockPipeline(
  repoUrl: string,
  onStage: (e: StageEvent) => void,
  signal?: AbortSignal
): Promise<PipelineResult> {
  await wait(1200, signal);
  onStage({ stage: "ingest", ok: true });

  await wait(1800, signal);
  onStage({ stage: "explain", ok: true });

  await wait(2200, signal);
  onStage({ stage: "render", ok: true });

  const name = repoUrl.replace(/\/$/, "").split("/").slice(-2).join("/") || "example/demo-repo";

  return {
    repo: name,
    architectureSummary:
      `## ${name}\n\nThis is a **mock** summary shown because no backend URLs are configured yet ` +
      `(\`VITE_INGEST_URL\`, \`VITE_EXPLAIN_URL\`, \`VITE_RENDER_URL\`).\n\n` +
      `- Entry point and routing are cleanly separated\n- Auth lives in its own module\n- Data access is isolated behind a thin layer`,
    sections: MOCK_SECTIONS,
    videos: MOCK_SECTIONS.map((s) => ({
      title: s.title,
      video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
      status: "completed" as const,
    })),
    diagramImageUrl: null,
    // MOCK_MERMAID_DIAGRAM's node lettering (A-E) matches MOCK_SECTIONS'
    // node_ids above — keep them in sync if either changes.
    mermaidDiagram: MOCK_MERMAID_DIAGRAM,
    diagramHighlights: sectionsToDiagramHighlights(MOCK_SECTIONS),
    ingestion: {
      repo_url: name,
      file_tree:
        "src/\n  index.js\n  routes/\n  services/auth.js\npackage.json\nREADME.md\n.github/workflows/ci.yml\ntests/\n  auth.test.js",
      readme: `# ${name}\n\nMock ingestion data — no real repo was read since the backend isn't configured.`,
      key_files: [],
      recent_commits: [{ message: "fix auth middleware", date: new Date().toISOString() }],
      package_manifest: '{"dependencies":{"express":"^4.18.0","react":"^19.0.0"}}',
    },
  };
}

async function runMockDiffPipeline(
  repoUrl: string,
  baseRef: string,
  headRef: string,
  onStage: (e: StageEvent) => void,
  signal?: AbortSignal
): Promise<DiffPipelineResult> {
  await wait(1000, signal);
  onStage({ stage: "ingest", ok: true });

  await wait(1500, signal);
  onStage({ stage: "explain", ok: true });

  await wait(2000, signal);
  onStage({ stage: "render", ok: true });

  const name = repoUrl.replace(/\/$/, "").split("/").slice(-2).join("/") || "example/demo-repo";
  const section: ExplainSection = {
    title: "What Changed",
    script:
      `This is a mock diff narration, shown because no backend URLs are configured yet. Between ${baseRef} and ${headRef}, ` +
      `a handful of files changed. In a real run, this would call out actual behavior changes and why they likely matter to someone coming back to this code after time away — not just a list of files.`,
  };

  return {
    repo: name,
    baseRef,
    headRef,
    section,
    video: {
      title: section.title,
      video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
      status: "completed",
    },
    filesChanged: 3,
    totalFilesChanged: 3,
  };
}

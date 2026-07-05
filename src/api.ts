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
}

export interface ExplainResult {
  architecture_summary: string;
  narration_script: { sections: ExplainSection[] };
  mermaid_diagram: string | null;
}

export interface VideoSection {
  title: string;
  video_url: string | null;
  status: "processing" | "ready" | "failed";
}

export interface RenderResult {
  status: "processing" | "ready" | "partial" | "failed";
  job_id?: string;
  videos: VideoSection[];
  diagram_image_url?: string | null;
}

export interface PipelineResult {
  repo: string;
  architectureSummary: string;
  sections: ExplainSection[];
  videos: VideoSection[];
  diagramImageUrl: string | null;
}

const INGEST_URL = import.meta.env.VITE_INGEST_URL as string | undefined;
const EXPLAIN_URL = import.meta.env.VITE_EXPLAIN_URL as string | undefined;
const RENDER_URL = import.meta.env.VITE_RENDER_URL as string | undefined;

const USING_REAL_BACKEND = Boolean(INGEST_URL && EXPLAIN_URL && RENDER_URL);

export function backendMode(): "live" | "mock" {
  return USING_REAL_BACKEND ? "live" : "mock";
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

  // 3. Render — kick off async job, then poll
  const kickoff = await postJSON<RenderResult>(
    `${RENDER_URL}/render`,
    { sections: explainRes.narration_script.sections },
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`${url} -> ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
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

const MOCK_SECTIONS: ExplainSection[] = [
  { title: "Overview", script: "This project is a modular service with a clear entry point and a small set of core routes." },
  { title: "Auth Module", script: "Authentication is handled in a dedicated module, separating login and token logic from the rest of the app." },
  { title: "API Layer", script: "The API layer routes requests into core logic and talks to the database through a thin data-access layer." },
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
      status: "ready" as const,
    })),
    diagramImageUrl: null,
  };
}

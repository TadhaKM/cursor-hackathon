// mockApi.ts
// Stand-in for the real pipeline until Person 1 / 2 / 3's endpoints are ready.
// Swap the bodies of these functions for real fetch() calls — the shape
// (stage callbacks + final payload) is the contract the UI depends on.

export type StageId = "fetch" | "analyze" | "narrate" | "render";

export interface StageResult {
  stage: StageId;
  ok: boolean;
}

export interface PipelineResult {
  repo: string;
  summary: string;
  videoUrl: string;
  diagram: string;
}

const STAGE_DELAYS: Record<StageId, number> = {
  fetch: 1100,
  analyze: 1800,
  narrate: 1600,
  render: 2200,
};

export const STAGES: { id: StageId; label: string }[] = [
  { id: "fetch", label: "fetching repo" },
  { id: "analyze", label: "analyzing architecture" },
  { id: "narrate", label: "writing narration" },
  { id: "render", label: "rendering video" },
];

// Simulates the whole pipeline, calling onStage after each step completes.
// forceFailAt lets the demo trigger the error state on command.
export async function runPipeline(
  repoUrl: string,
  onStage: (result: StageResult) => void,
  forceFailAt?: StageId
): Promise<PipelineResult> {
  for (const { id } of STAGES) {
    await wait(STAGE_DELAYS[id]);
    if (forceFailAt === id) {
      onStage({ stage: id, ok: false });
      throw new Error(`Stage "${id}" failed`);
    }
    onStage({ stage: id, ok: true });
  }

  const name = repoUrl.replace(/\/$/, "").split("/").slice(-2).join("/") || repoUrl;

  return {
    repo: name,
    summary:
      `${name} is a modular service with a clear entry point, a small set of ` +
      `core routes, and a handful of recent PRs focused on auth and deploy config.`,
    videoUrl:
      "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    diagram: `graph TD
  A[Client] --> B[API Layer]
  B --> C[Auth Service]
  B --> D[Core Logic]
  D --> E[(Database)]`,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

# repo → video (frontend)

Frontend for the codebase-to-onboarding-video pipeline. Ships with a mocked
backend (`src/mockApi.ts`) so it runs standalone before the other three
pieces are wired up.

## Run locally

```
npm install
npm run dev
```

## Swap in the real pipeline

Everything backend-shaped lives in `src/mockApi.ts`. Replace `runPipeline`
with real calls once endpoints exist:

- **Person 1** — repo ingestion: `GET /repo-summary-input?url=...`
- **Person 2** — Qwen summary + narration script
- **Person 3** — HeyGen video generation (async, needs polling)

Keep the same shape: a function that reports each stage as it completes
(`onStage({ stage, ok })`) and resolves with `{ repo, summary, videoUrl, diagram }`.
If Person 3's video generation is a job-id + poll flow, wrap the polling
inside `runPipeline` so the UI doesn't need to change.

## Deploy on Render

1. New "Static Site" on Render, point at this repo/folder.
2. Build command: `npm install && npm run build`
3. Publish directory: `dist`
4. Add any API base URL as an environment variable (e.g. `VITE_API_BASE`)
   and reference it in `mockApi.ts` once real endpoints replace the mocks.

## Demo notes

- The "Simulate failure" button on the input screen forces the render
  stage to fail, so you can show the error/retry state on demand without
  waiting for a real API to flake.
- Pre-load a known-good, small repo before going on stage as a fallback
  in case live input misbehaves.

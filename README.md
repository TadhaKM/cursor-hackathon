# repo → video (frontend)

Frontend for the codebase-to-onboarding-video pipeline. Wired to the team's
locked data contract in `src/api.ts`:

```
POST {VITE_INGEST_URL}/ingest    -> IngestResult
POST {VITE_EXPLAIN_URL}/explain  -> ExplainResult
POST {VITE_RENDER_URL}/render    -> kicks off async video jobs
GET  {VITE_RENDER_URL}/render/:job_id  -> polled until ready/partial/failed
```

## Run locally

```
npm install
npm run dev
```

### Mock mode (default until teammates deploy)

If `VITE_INGEST_URL`, `VITE_EXPLAIN_URL`, and `VITE_RENDER_URL` aren't set,
the app automatically falls back to mock data — so it's fully clickable and
testable right now, before any backend exists. A pill in the top bar shows
`○ mock data` vs `● live backend` so it's always obvious which mode you're in.

### Connecting to real backends

Copy `.env.example` to `.env.local` and fill in the three URLs once your
teammates have something deployed:

```
VITE_INGEST_URL=https://repo-ingest.onrender.com
VITE_EXPLAIN_URL=https://repo-explainer.onrender.com
VITE_RENDER_URL=https://video-renderer.onrender.com
```

No code changes needed — just set the env vars (locally in `.env.local`,
or in Render's dashboard when deployed) and the app switches from mock to
live automatically.

## What's implemented

- **Input** — repo URL + persona toggle (New grad / Senior engineer), passed
  through to `/explain`.
- **Progress** — commit-graph visual across the 3 real pipeline stages
  (ingest → explain → render), reflecting actual async state.
- **Result** — one video per section with a sidebar to jump between them,
  architecture diagram image if provided, collapsible full summary
  (rendered from markdown), and a Qwen-powered chat box for repo questions.
- **Ask assistant** — floating `?` button on every page; answers tool questions
  globally, or repo questions after a walkthrough is ready.
- **Error** — shows which stage failed and the raw error message, with retry.

## Chat

Both chat UIs (the result-page chat box and the floating `?` assistant) call
Person 2's existing `POST {VITE_EXPLAIN_URL}/chat` endpoint in
`services/repo-explainer` — no separate proxy, deployment, or API key needed
on the frontend side. That service already chunks the ingested key files,
retrieves the most relevant ones for the question, and answers with Qwen
(keyed server-side via `QWEN_API_KEY`).

- On the results page, the real ingestion payload from `/ingest` is sent
  along with each question, so answers are grounded in the actual repo files.
- Before a repo's been processed (or for general tool questions via the `?`
  button), a small built-in "tool docs" payload is sent instead, so the same
  endpoint can answer FAQ-style questions about the tool itself.
- If `VITE_EXPLAIN_URL` isn't set, chat runs in **mock mode** like the rest
  of the pipeline — same pill pattern, no separate flag to manage.

## Deploy on Render

1. New "Static Site" on Render, point at this repo/folder.
2. Build command: `npm install && npm run build`
3. Publish directory: `dist`
4. Set the three `VITE_*_URL` env vars in the Render dashboard once the
   backend services are deployed. Leave unset to keep running in mock mode.

See `render.yaml` at the repo root for the full 4-service Blueprint once
all three backend folders exist.

## Demo notes

- Mock mode is a legitimate fallback for the live demo if a real API flakes
  on stage — the pill just needs to say `mock data` and judges won't mind.
- Pre-load a known-good, small repo before going on stage in case live
  input misbehaves.

# repo → video (frontend)

Frontend for the codebase-to-onboarding-video pipeline. Wired to the team's
locked data contract in `src/api.ts`:

```
POST {VITE_INGEST_URL}/ingest    -> IngestResult
POST {VITE_EXPLAIN_URL}/explain  -> ExplainResult
POST {VITE_RENDER_URL}/render    -> kicks off async video jobs
GET  {VITE_RENDER_URL}/render/:job_id  -> polled until ready/partial/failed
POST {VITE_CHAT_URL}             -> { answer, sources }  (Gemini proxy)
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

### Connecting to real backends (local full stack)

Copy `.env.example` to `.env.local` and set the three pipeline URLs. With all
three set, the top bar shows `● live backend`. Restart Vite after changing env
vars (`npm run dev`).

```
VITE_INGEST_URL=http://localhost:3000
VITE_EXPLAIN_URL=http://localhost:8787
VITE_RENDER_URL=http://localhost:8000
```

**Four terminals + frontend** (from the `repo-to-video/` root unless noted):

| Terminal | Service | Command |
|----------|---------|---------|
| 1 | Person 1 — ingest | `cd repo-ingest && npm install && npm run dev` |
| 2 | Person 2 — explain + chat | `cd services/repo-explainer && npm install && npm run dev` (needs `QWEN_API_KEY` in `.env`) |
| 3 | Person 3 — render | `cd video-renderer && uvicorn app.main:app --reload --port 8000` (`.env` with HeyGen keys or `MOCK_VIDEO=true`) |
| 4 | Person 4 — frontend | `npm install && npm run dev` |

Health checks (optional): `curl http://localhost:3000/health`, `curl http://localhost:8787/health`, `curl http://localhost:8000/health`.

For production, swap localhost URLs for deployed Render service URLs:

```
VITE_INGEST_URL=https://repo-ingest.onrender.com
VITE_EXPLAIN_URL=https://repo-explainer.onrender.com
VITE_RENDER_URL=https://video-renderer.onrender.com
```

No code changes needed — the app switches from mock to live automatically when
all three pipeline URLs are set.

## What's implemented

- **Input** — repo URL + persona toggle (New grad / Senior engineer), passed
  through to `/explain`.
- **Progress** — commit-graph visual across the 3 real pipeline stages
  (ingest → explain → render), reflecting actual async state.
- **Result** — one video per section with a sidebar to jump between them,
  architecture diagram image if provided, collapsible full summary
  (rendered from markdown), and a Gemini-powered chat box for repo questions.
- **Ask assistant** — floating `?` button on every page; answers tool questions
  globally, or repo questions after a walkthrough is ready.
- **Error** — shows which stage failed and the raw error message, with retry.

## Chat (Gemini proxy or Person 2 Qwen RAG)

Chat is **separate from the explain pipeline**. Person 2's `/explain` endpoint
still uses Qwen via `VITE_EXPLAIN_URL`. Chat picks a backend automatically:

| Config | Repo chat (results page) | Tool chat (floating `?`) | ChatPanel pill |
|--------|--------------------------|--------------------------|----------------|
| `VITE_CHAT_URL` set | Gemini proxy (`api/chat.ts`) | Gemini + `TOOL_DOCS` | `● Gemini` |
| Only `VITE_EXPLAIN_URL` set | Person 2 `POST /chat` (Qwen RAG) | Mock (built-in FAQ text) | `● Qwen (Person 2 RAG)` |
| Neither set | Mock | Mock | `○ mock chat` |

Pipeline mock/live (`● live backend` / `○ mock data`) is independent of chat mode.

### Optional: Gemini proxy (Vercel)

For tool FAQ and repo chat via Gemini, deploy the serverless proxy so
`GEMINI_API_KEY` never ships to the browser.

Create a key at [Google AI Studio](https://aistudio.google.com/apikey).
**Never commit the key** — add it only to `.env.local` (local) or the Vercel
dashboard (production).

### Deploy the proxy to Vercel

From this folder:

```
npm install
npx vercel link          # first time only
npx vercel env add GEMINI_API_KEY
npx vercel env add GEMINI_MODEL   # optional, default gemini-2.0-flash
npx vercel env add ALLOWED_ORIGIN   # optional, e.g. your Render frontend URL
npx vercel deploy --prod
```

Server env vars (Vercel dashboard or `.env.local` for `vercel dev`):

| Variable | Required | Notes |
|----------|----------|-------|
| `GEMINI_API_KEY` | yes | From AI Studio — **no `VITE_` prefix** |
| `GEMINI_MODEL` | no | Default `gemini-2.0-flash` |
| `ALLOWED_ORIGIN` | no | CORS allowlist for your frontend origin |

### Point the frontend at the proxy

Set `VITE_CHAT_URL` in `.env.local` or Render:

```
# Local — use port 3001 so ingest (3000) doesn't clash
VITE_CHAT_URL=http://localhost:3001/api/chat

# Production
VITE_CHAT_URL=https://<your-vercel-project>.vercel.app/api/chat
```

Local dev with the proxy (optional 5th terminal):

```
# Terminal — Gemini proxy (reads GEMINI_API_KEY from .env.local)
npm run dev:api

# Frontend (restart after env change)
npm run dev
```

Both chat UIs POST to `VITE_CHAT_URL` with `{ context_type, question, ingestion }`:

- **repo** — grounded in the ingested README, file tree, and top key files
- **tool** — uses built-in `TOOL_DOCS` for FAQ-style questions

If neither `VITE_CHAT_URL` nor `VITE_EXPLAIN_URL` is set, chat runs in **mock mode**.

## Also new: transcript, shortcuts, history, and export

- **Transcript panel** — the narration script for the active section is shown
  next to its video on the results page (previously it was only ever spoken,
  never displayed).
- **Keyboard shortcuts** — `←`/`→` or `[`/`]` to move between result sections,
  `Ctrl`/`Cmd`+`Enter` to send a chat message, and `?` to open a shortcuts
  cheat-sheet (`Esc` closes any modal).
- **Walkthrough history** — every completed run is saved to `localStorage`
  (`src/history.ts`) so you can reopen a past walkthrough instantly from the
  input screen without re-running the pipeline. Reopening also updates the
  URL hash (`#walk/<id>`), so a "Copy link" on the results page gives you a
  link that rehydrates that exact walkthrough on load.
- **Export** — download the architecture summary + full narration script as
  a `.md` file, or copy just the summary, both with toast confirmations
  (`src/Toast.tsx`) instead of ad hoc button-text swaps.

## Deploy on Render (Person 4 checklist)

1. New **Static Site** on Render, point at this repo/folder.
2. **Build command:** `npm install && npm run build`
3. **Publish directory:** `dist`
4. **Environment variables** (Render dashboard → Environment):

| Variable | Required | Example |
|----------|----------|---------|
| `VITE_INGEST_URL` | yes (live pipeline) | `https://your-repo-ingest.onrender.com` |
| `VITE_EXPLAIN_URL` | yes (live pipeline) | `https://your-repo-explainer.onrender.com` |
| `VITE_RENDER_URL` | yes (live pipeline) | `https://your-video-renderer.onrender.com` |
| `VITE_CHAT_URL` | optional | `https://your-project.vercel.app/api/chat` |

5. Leave all three pipeline URLs **unset** to keep mock mode for demos.
6. Redeploy after changing env vars (Vite bakes them in at build time).
7. If using Gemini chat, set `GEMINI_API_KEY` on **Vercel** (not Render) and
   add `ALLOWED_ORIGIN` to your Render static site URL for CORS.

Each backend folder (`repo-ingest/`, `services/repo-explainer/`,
`video-renderer/`) deploys as its own Render service — currently only
`repo-ingest/render.yaml` exists. There's no root-level Blueprint tying all
four services together yet; until one exists, deploy each service manually
(or add per-service `render.yaml` files and a root Blueprint that references
them).

## Demo notes

- Mock mode is a legitimate fallback for the live demo if a real API flakes
  on stage — the pill just needs to say `mock data` and judges won't mind.
- Pre-load a known-good, small repo before going on stage in case live
  input misbehaves.

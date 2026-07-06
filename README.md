# Redio

Turn any public GitHub repo into a short, narrated **onboarding walkthrough
video** — with a spoken script, a talking-avatar video per section, an
architecture diagram, and a chat box grounded in the repo's actual code.

## How it works

Four independent pieces, wired together by the frontend:

```
                    ┌──────────────────────────────────────────────┐
                    │  Frontend (Vite + React)  ── src/, Netlify    │
                    │  paste a repo URL, watch the walkthrough      │
                    └──────────────────────────────────────────────┘
                        │            │             │           │
              POST /ingest   POST /explain   POST /render   POST /api/chat
                        ▼            ▼             ▼           ▼
        ┌───────────────┐  ┌────────────────┐  ┌───────────────┐  ┌──────────────┐
        │ repo-ingest   │  │ repo-explainer │  │ video-renderer│  │ chat function│
        │ Node/Express  │  │ Node/Express   │  │ Python/FastAPI│  │ Netlify fn   │
        │ GitHub API →  │  │ LLM → summary, │  │ HeyGen → video│  │ LLM Q&A over │
        │ trimmed repo  │  │ narration,     │  │ Kroki → diagram│ │ the repo     │
        │ context JSON  │  │ mermaid        │  │ image          │  │              │
        └───────────────┘  └────────────────┘  └───────────────┘  └──────────────┘
                                   │                                      │
                              OpenRouter (google/gemini-2.5-flash, OpenAI-compatible)
```

1. **repo-ingest** — fetches a repo from the GitHub API and returns a compact,
   token-budgeted JSON snapshot (file tree, README, key files, recent commits,
   manifest).
2. **repo-explainer** — feeds that snapshot to an LLM (via OpenRouter) and
   produces an architecture summary, a spoken narration script (split into
   sections), and a mermaid diagram. Also serves `/chat` RAG over the repo.
3. **video-renderer** — turns each narration section into a HeyGen talking-avatar
   video (async job + polling) and renders the mermaid diagram to a PNG via Kroki.
4. **frontend** — drives the pipeline, plays the videos with subtitles + an
   animated walkthrough map, and hosts the chat box (a Netlify function that
   proxies the LLM).

The three backends are **stateful/long-running** (async jobs, minutes-long LLM
calls), so they run on **Render**. The frontend + chat function are static +
serverless, so they run on **Netlify** (or Vercel — both configs are included).

## Repo layout

```
repo-ingest/            Node service — GitHub → ingestion JSON     (port 3000)
services/repo-explainer/ Node service — ingestion → LLM outputs    (port 8787)
video-renderer/         Python service — narration → HeyGen video  (port 8000)
src/                    Frontend (Vite + React + TypeScript)
netlify/functions/      chat.js — Netlify serverless chat proxy
api/chat.ts             chat proxy for Vercel (equivalent of the above)
render.yaml             Render Blueprint for all 3 backends
netlify.toml            Netlify build + function + redirect config
DEPLOY.md               Step-by-step hosting guide
```

## Run locally

Each backend reads its own gitignored `.env` (copy from the `.env.example`
beside it). You need three API keys: **GitHub token** (ingest), **OpenRouter
key** (explain + chat), **HeyGen key** (render).

```bash
# 1. repo-ingest      — needs GITHUB_TOKEN
cd repo-ingest && npm install && npm start

# 2. repo-explainer   — needs OPENROUTER_API_KEY
cd services/repo-explainer && npm install && npm start

# 3. video-renderer   — needs HEYGEN_API_KEY (or MOCK_VIDEO=true for fakes)
cd video-renderer && python -m venv .venv && ./.venv/Scripts/pip install -r requirements.txt
./.venv/Scripts/uvicorn app.main:app --port 8000

# 4. frontend         — point it at the three backends
cp .env.example .env.local        # VITE_INGEST_URL / VITE_EXPLAIN_URL / VITE_RENDER_URL
npm install && npm run dev        # http://localhost:5173
```

If the `VITE_*` URLs aren't set, the frontend runs a **built-in mock pipeline**
so the UI is clickable without any backend (the top bar shows `mock` vs
`live backend`).

Health checks: `curl localhost:3000/health`, `localhost:8787/health`,
`localhost:8000/health`.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** for the full walkthrough. In short:

- **Backends → Render**: `New + → Blueprint` reads `render.yaml` and creates all
  three services. Set each one's secret (`GITHUB_TOKEN`, `OPENROUTER_API_KEY`,
  `HEYGEN_API_KEY`).
- **Frontend → Netlify**: auto-reads `netlify.toml`. Set `VITE_INGEST_URL` /
  `VITE_EXPLAIN_URL` / `VITE_RENDER_URL` to the Render URLs, `VITE_CHAT_URL=/api/chat`,
  and `OPENROUTER_API_KEY` (for the chat function). Redeploy after setting them —
  `VITE_*` vars are baked in at build time.

## Notes / limitations

- **API keys** live only in gitignored `.env` files locally, and in each host's
  dashboard for production — never committed.
- **Free tiers**: OpenRouter (no credits) caps tokens per request; HeyGen needs
  render credits. Both work for a demo; add credits for headroom.
- **Diagram images** are written to the renderer's local disk — fine for a
  single instance, ephemeral on redeploy.
- Use **small/medium public repos** for the smoothest runs.

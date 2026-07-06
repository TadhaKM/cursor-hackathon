# Deploying repo → video

Four pieces: three backend services on **Render**, and the frontend (+ its
`/api/chat` function) on **Vercel**.

```
Frontend (Vercel) ──> repo-ingest      (Render)  GET/POST  GitHub
                 ──> repo-explainer    (Render)  Gemini
                 ──> video-renderer     (Render)  HeyGen + Kroki
                 ──> /api/chat          (Vercel function)  Gemini
```

Deploy the **backends first** (you need their URLs for the frontend), then the
frontend.

Secrets never live in git — set them in each platform's dashboard.

---

## 1. Backends on Render

Easiest path — **Blueprint** (deploys all three at once from `render.yaml`):

1. Render dashboard → **New + → Blueprint** → connect this repo.
2. Render reads `render.yaml` and creates `repo-ingest`, `repo-explainer`,
   `video-renderer`.
3. For each service, open its **Environment** tab and set the secret(s) marked
   `sync: false`:

| Service | Secret env var | Value |
| --- | --- | --- |
| repo-ingest | `GITHUB_TOKEN` | your GitHub token (classic, no scopes needed for public repos) |
| repo-explainer | `GEMINI_API_KEY` | your Google AI Studio key |
| video-renderer | `HEYGEN_API_KEY` | your HeyGen key |

The non-secret vars (`GEMINI_MODEL`, `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`,
`CACHE_TTL_MS`, …) are already baked into `render.yaml`. `PUBLIC_BASE_URL`
auto-derives from Render's `RENDER_EXTERNAL_URL`, so leave it unset.

4. Deploy. Note the three resulting URLs, e.g.:
   - `https://repo-ingest.onrender.com`
   - `https://repo-explainer.onrender.com`
   - `https://video-renderer.onrender.com`

Sanity-check each:
```
curl https://repo-ingest.onrender.com/health
curl https://repo-explainer.onrender.com/health
curl https://video-renderer.onrender.com/
```

(Manual alternative: create each as a **Web Service**, set **Root Directory**
to `repo-ingest` / `services/repo-explainer` / `video-renderer`, and use the
build/start commands from `render.yaml`.)

---

## 2. Frontend on Vercel

1. Vercel → **New Project** → import this repo. Framework: **Vite**
   (build `npm run build`, output `dist`). `` wires the
   `/api/chat` serverless function automatically.
2. **Settings → Environment Variables** (set for Production):

| Var | Value |
| --- | --- |
| `VITE_INGEST_URL` | `https://repo-ingest.onrender.com` |
| `VITE_EXPLAIN_URL` | `https://repo-explainer.onrender.com` |
| `VITE_RENDER_URL` | `https://video-renderer.onrender.com` |
| `VITE_CHAT_URL` | `/api/chat` |
| `GEMINI_API_KEY` | your Google AI Studio key (server-side, for `/api/chat`) |
| `GEMINI_MODEL` | `gemini-2.5-flash` (optional) |

> `VITE_*` vars are inlined at build time, so a change to them needs a
> redeploy. `GEMINI_API_KEY` is read at runtime by the function.

3. Deploy. Open the Vercel URL and run a small repo end-to-end.

---

## Notes & limitations

- **Free tiers**: Gemini free tier is ~20 requests/min; HeyGen needs render
  credits. Fine for a demo, not sustained load. Enabling billing on the Gemini
  key removes the rate wall.
- **Diagram images are ephemeral**: `video-renderer` writes diagram PNGs to
  local `static/`. Render's disk is wiped on redeploy/restart and isn't shared
  across instances, so keep it to **one instance** (free tier is single-instance
  anyway). For durability, move to object storage later.
- **Render free services sleep** after inactivity; the first request after idle
  is slow (cold start).
- **Render sleep + HeyGen render time**: a large repo (many sections) can take
  several minutes to render; the frontend polls for up to 5 minutes.
- **CORS** is already permissive (`*`) on all three backends.

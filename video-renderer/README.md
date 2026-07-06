# video-renderer

Stage 3 of the Redio pipeline. Takes narration script sections + an optional
mermaid diagram and produces HeyGen talking-avatar videos (one per section) plus
a rendered diagram image (via Kroki).

## Setup

```
cd video-renderer
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

**No HeyGen key or credits?** Set `MOCK_VIDEO=true` in `.env` to skip HeyGen and
return instant placeholder videos — the rest of the pipeline (including the real
diagram) still works, which is ideal for frontend dev and demos.

For real videos, set `HEYGEN_API_KEY`, then fetch avatar/voice IDs and set them too:

```
uvicorn app.main:app --reload --port 8000
curl http://localhost:8000/avatars | jq
curl http://localhost:8000/voices | jq
```

Pick one avatar and one voice you like, put their IDs in `.env` as
`HEYGEN_AVATAR_ID` / `HEYGEN_VOICE_ID`. All rendered sections use the same
avatar/voice for visual consistency across the video.

Run the server:

```
uvicorn app.main:app --reload --port 8000
```

## API

### `GET /` and `GET /health`

Health check — returns `{ "ok": true, "service": "video-renderer" }`.

### `POST /render`

```json
{
  "sections": [
    { "title": "Overview", "script": "This project is..." },
    { "title": "Auth Module", "script": "Auth lives in..." }
  ],
  "mermaid_diagram": "graph TD\nA-->B"
}
```

Returns immediately with a `job_id` and per-section status `"processing"`.
All HeyGen render jobs are submitted in parallel (not one at a time — each
one takes 1-3 min), then polled concurrently in the background.

```json
{
  "job_id": "…",
  "status": "processing",
  "videos": [
    { "title": "Overview", "video_url": null, "status": "processing" }
  ],
  "video_urls": [],
  "diagram_image_url": null
}
```

### `GET /render/{job_id}`

Poll this every 5-10s from the frontend. Same shape as above; once done:

```json
{
  "job_id": "…",
  "status": "ready",
  "videos": [
    { "title": "Overview", "video_url": "https://…mp4", "status": "completed" }
  ],
  "video_urls": ["https://…mp4"],
  "diagram_image_url": "https://…/static/diagram-abc123.png"
}
```

`status` is `"ready"` (all sections done), `"partial"` (some failed after
retry), or `"failed"` (all failed).

### `GET /avatars`, `GET /voices`

Proxies HeyGen's avatar/voice lists — use these once to pick the IDs for
`.env`, not from the frontend.

## Notes

- A failed HeyGen render is retried once automatically before being marked
  `"failed"` for that section.
- Diagram rendering uses the public Kroki API (`kroki.io/mermaid/png`) — no
  local mermaid-cli/puppeteer install needed. Node labels with special
  characters are quoted first so Kroki's parser doesn't choke (`app/diagram.py`).
  The rendered PNG is saved to `static/` and served from this same service. The
  returned URL is absolute, built from `PUBLIC_BASE_URL` — which auto-derives
  from Render's `RENDER_EXTERNAL_URL` in production, so no manual config needed.
  (Note: `static/` is local disk — ephemeral on redeploy, so run one instance.)
- HeyGen captions are burned into the rendered videos (`caption: true`).
- A failed HeyGen render is retried once before being marked `"failed"`; a job
  that hits an unexpected error is marked `"failed"` rather than hanging.
- Real rendering requires HeyGen *API* credits on the account — without them,
  `/render` fails fast with `MOVIO_PAYMENT_INSUFFICIENT_CREDIT`. Use
  `MOCK_VIDEO=true` if you don't have credits.
- `curl` smoke test:
  ```
  curl -X POST localhost:8000/render -H 'Content-Type: application/json' \
    -d '{"sections":[{"title":"Overview","script":"hello"}]}'
  ```

# video-renderer (Person 3)

Takes narration script sections + an optional mermaid diagram, and produces
HeyGen talking-avatar videos + a rendered diagram image.

## Setup

```
cd video-renderer
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

To run without a HeyGen key (frontend dev, demo rehearsal), set in `.env`:

```
MOCK_VIDEO=true
```

To render for real, set `HEYGEN_API_KEY`, then fetch avatar/voice IDs and
set them too:

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
  local mermaid-cli/puppeteer install needed. It runs even in mock mode
  since it's free. The rendered PNG is saved to `static/` and served from
  this same service; set `PUBLIC_BASE_URL` in `.env` once deployed so the
  returned URL is absolute (e.g. your Render service URL).
- Confirm HeyGen's `/v2/video/generate` and `/v1/video_status.get` shapes
  against their current docs before a real run — video-gen APIs shift
  between versions and this was built from the partner docs link.
- `curl` smoke test (mock mode):
  ```
  curl -X POST localhost:8000/render -H 'Content-Type: application/json' \
    -d '{"sections":[{"title":"Overview","script":"hello"}]}'
  ```

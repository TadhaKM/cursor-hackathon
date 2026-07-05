import asyncio
import uuid

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import config, diagram, heygen, store
from app.models import JobState, RenderRequest, VideoState

app = FastAPI(title="video-renderer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=str(diagram.STATIC_DIR.parent / "static")), name="static")


@app.get("/")
async def health():
    return {"ok": True}


@app.post("/render", response_model=JobState)
async def render(req: RenderRequest):
    if not req.sections:
        raise HTTPException(400, "sections must contain at least one item")

    job_id = str(uuid.uuid4())
    job = JobState(
        job_id=job_id,
        status="processing",
        videos=[VideoState(title=s.title, status="processing") for s in req.sections],
    )
    store.create(job)

    asyncio.create_task(_run_job(job_id, req))
    return job


@app.get("/render/{job_id}", response_model=JobState)
async def get_render(job_id: str):
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job_id")
    return job


@app.get("/avatars")
async def avatars():
    if not config.HEYGEN_API_KEY:
        raise HTTPException(400, "HEYGEN_API_KEY not set")
    async with httpx.AsyncClient() as client:
        return await heygen.list_avatars(client)


@app.get("/voices")
async def voices():
    if not config.HEYGEN_API_KEY:
        raise HTTPException(400, "HEYGEN_API_KEY not set")
    async with httpx.AsyncClient() as client:
        return await heygen.list_voices(client)


async def _run_job(job_id: str, req: RenderRequest) -> None:
    try:
        await _run_job_inner(job_id, req)
    except Exception as exc:  # never leave a job stuck in "processing"
        job = store.get(job_id)
        if job is not None:
            job.status = "failed"
            job.videos = [
                VideoState(title=v.title, status="failed", error=f"internal error: {exc}")
                for v in job.videos
            ]
            store.save(job)


async def _run_job_inner(job_id: str, req: RenderRequest) -> None:
    job = store.get(job_id)

    async with httpx.AsyncClient() as client:
        # Submit/poll every section in parallel — don't wait on one before
        # starting the next, since HeyGen renders take 1-3 min each.
        render_tasks = [heygen.render_section(s.title, s.script, client) for s in req.sections]

        diagram_task = (
            diagram.render_mermaid_to_png(req.mermaid_diagram, client)
            if req.mermaid_diagram
            else None
        )

        if diagram_task is not None:
            results, diagram_url = await asyncio.gather(
                asyncio.gather(*render_tasks), diagram_task
            )
        else:
            results = await asyncio.gather(*render_tasks)
            diagram_url = None

    videos = [
        VideoState(
            title=r["title"],
            video_url=r.get("video_url"),
            status=r["status"],
            error=r.get("error"),
        )
        for r in results
    ]
    video_urls = [v.video_url for v in videos if v.video_url]

    if all(v.status == "completed" for v in videos):
        overall_status = "ready"
    elif any(v.status == "completed" for v in videos):
        overall_status = "partial"
    else:
        overall_status = "failed"

    job.status = overall_status
    job.videos = videos
    job.video_urls = video_urls
    job.diagram_image_url = diagram_url
    store.save(job)

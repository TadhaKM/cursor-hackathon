from typing import Literal, Optional

from pydantic import BaseModel

VideoStatus = Literal["processing", "completed", "failed"]
JobStatus = Literal["processing", "ready", "partial", "failed"]


class Section(BaseModel):
    title: str
    script: str


class RenderRequest(BaseModel):
    sections: list[Section]
    mermaid_diagram: Optional[str] = None
    # Optional HeyGen cloned-voice ID (from POST /voice/clone). If set, every
    # section is narrated in that voice instead of HEYGEN_VOICE_ID — this is
    # a normal HeyGen voice_id once cloning completes, so it flows through
    # the existing text-to-speech path with no other change.
    voice_id: Optional[str] = None


class VideoState(BaseModel):
    title: str
    video_url: Optional[str] = None
    status: VideoStatus = "processing"
    error: Optional[str] = None


class JobState(BaseModel):
    job_id: str
    status: JobStatus = "processing"
    videos: list[VideoState] = []
    video_urls: list[str] = []
    diagram_image_url: Optional[str] = None

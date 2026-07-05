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

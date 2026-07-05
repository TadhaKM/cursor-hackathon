import uuid
from pathlib import Path

import httpx

from app import config

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


async def render_mermaid_to_png(mermaid_source: str, client: httpx.AsyncClient) -> str:
    """Render mermaid syntax to a PNG via the public Kroki API, save it under
    static/, and return the absolute URL to it. Returns None on failure —
    the diagram is optional, a broken render shouldn't fail the whole job."""
    try:
        resp = await client.post(
            f"{config.KROKI_BASE_URL}/mermaid/png",
            content=mermaid_source.encode("utf-8"),
            headers={"Content-Type": "text/plain"},
            timeout=30,
        )
        resp.raise_for_status()
    except httpx.HTTPError:
        return None

    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"diagram-{uuid.uuid4().hex}.png"
    (STATIC_DIR / filename).write_bytes(resp.content)
    return f"{config.PUBLIC_BASE_URL}/static/{filename}"

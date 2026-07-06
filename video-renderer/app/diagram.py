import re
import uuid
from pathlib import Path

import httpx

from app import config

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Rectangle node labels: [ ... ] with no nested brackets. This is the shape
# Gemini overwhelmingly emits, and the one that breaks when the label text
# contains special characters (parentheses, "@", "/", ":", etc. — e.g.
# "Server (src/server.js)" or "@scope/pkg").
_RECT_LABEL_RE = re.compile(r"\[([^\[\]]+)\]")

# Characters mermaid tolerates in an *unquoted* rectangle label. Anything else
# (parentheses, @, /, :, &, etc.) must be wrapped in quotes or the Kroki parse
# fails. Space, period, comma and hyphen are common and safe, so labels made of
# only these are left alone.
_SAFE_LABEL_RE = re.compile(r"^[\w .,\-]+$")


def _sanitize_mermaid(src: str) -> str:
    """Quote rectangle node-label text containing characters mermaid can't
    parse unquoted (parentheses, "@", "/", ":", etc.) so the Kroki render
    doesn't silently fail. Safe labels and already-quoted labels are untouched."""

    def quote(m: re.Match) -> str:
        text = m.group(1)
        if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
            return m.group(0)
        if _SAFE_LABEL_RE.match(text):
            return m.group(0)
        return '["' + text.replace('"', "#quot;") + '"]'

    return _RECT_LABEL_RE.sub(quote, src)


async def render_mermaid_to_png(mermaid_source: str, client: httpx.AsyncClient) -> str:
    """Render mermaid syntax to a PNG via the public Kroki API, save it under
    static/, and return the absolute URL to it. Returns None on failure —
    the diagram is optional, a broken render shouldn't fail the whole job."""
    sanitized = _sanitize_mermaid(mermaid_source)
    try:
        resp = await client.post(
            f"{config.KROKI_BASE_URL}/mermaid/png",
            content=sanitized.encode("utf-8"),
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

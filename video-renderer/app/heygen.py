import asyncio
import time

import httpx

from app import config


class HeyGenError(Exception):
    pass


def _headers() -> dict:
    return {"X-Api-Key": config.HEYGEN_API_KEY, "Content-Type": "application/json"}


async def submit_video(script: str, client: httpx.AsyncClient) -> str:
    """Submit one HeyGen video generation job, return its video_id."""
    if not config.HEYGEN_AVATAR_ID or not config.HEYGEN_VOICE_ID:
        raise HeyGenError(
            "HEYGEN_AVATAR_ID and HEYGEN_VOICE_ID must be set — pick IDs from "
            "GET /avatars and GET /voices first."
        )

    payload = {
        "video_inputs": [
            {
                "character": {
                    "type": "avatar",
                    "avatar_id": config.HEYGEN_AVATAR_ID,
                    "avatar_style": "normal",
                },
                "voice": {
                    "type": "text",
                    "input_text": script,
                    "voice_id": config.HEYGEN_VOICE_ID,
                },
                "background": {"type": "color", "value": "#0b0b0f"},
            }
        ],
        "dimension": {"width": 1280, "height": 720},
    }

    resp = await client.post(
        f"{config.HEYGEN_BASE_URL}/v2/video/generate",
        headers=_headers(),
        json=payload,
        timeout=30,
    )
    if resp.status_code >= 400:
        raise HeyGenError(f"HeyGen submit failed ({resp.status_code}): {resp.text}")

    data = resp.json()
    video_id = data.get("data", {}).get("video_id")
    if not video_id:
        raise HeyGenError(f"HeyGen submit returned no video_id: {data}")
    return video_id


async def check_status(video_id: str, client: httpx.AsyncClient) -> dict:
    """One status check. Returns {'status': 'processing'|'completed'|'failed', 'video_url': str|None, 'error': str|None}."""
    resp = await client.get(
        f"{config.HEYGEN_BASE_URL}/v1/video_status.get",
        headers=_headers(),
        params={"video_id": video_id},
        timeout=30,
    )
    if resp.status_code >= 400:
        raise HeyGenError(f"HeyGen status check failed ({resp.status_code}): {resp.text}")

    data = resp.json().get("data", {})
    status = data.get("status")
    if status == "completed":
        return {"status": "completed", "video_url": data.get("video_url"), "error": None}
    if status == "failed":
        return {"status": "failed", "video_url": None, "error": data.get("error")}
    return {"status": "processing", "video_url": None, "error": None}


async def poll_until_done(video_id: str, client: httpx.AsyncClient) -> dict:
    """Poll one video per the spec's schedule: every 5s for 30s, then every
    15s, capped at 5 minutes total."""
    start = time.monotonic()
    while True:
        result = await check_status(video_id, client)
        if result["status"] in ("completed", "failed"):
            return result

        elapsed = time.monotonic() - start
        if elapsed >= config.POLL_MAX_WAIT_S:
            return {"status": "failed", "video_url": None, "error": "timed out waiting for HeyGen render"}

        interval = (
            config.POLL_FAST_INTERVAL_S
            if elapsed < config.POLL_FAST_WINDOW_S
            else config.POLL_SLOW_INTERVAL_S
        )
        await asyncio.sleep(interval)


async def render_section(title: str, script: str, client: httpx.AsyncClient) -> dict:
    """Submit + poll one section, with one retry if the render fails."""
    for attempt in range(2):
        try:
            video_id = await submit_video(script, client)
            result = await poll_until_done(video_id, client)
        except HeyGenError as exc:
            result = {"status": "failed", "video_url": None, "error": str(exc)}

        if result["status"] == "completed" or attempt == 1:
            return {"title": title, **result}
    return {"title": title, **result}


async def list_avatars(client: httpx.AsyncClient) -> list:
    # HeyGen's full public avatar catalog (1000+ entries) routinely takes
    # 60-80s to enumerate — a short timeout here reads as a hang, it isn't.
    resp = await client.get(f"{config.HEYGEN_BASE_URL}/v2/avatars", headers=_headers(), timeout=100)
    resp.raise_for_status()
    return resp.json().get("data", {}).get("avatars", [])


async def list_voices(client: httpx.AsyncClient) -> list:
    resp = await client.get(f"{config.HEYGEN_BASE_URL}/v2/voices", headers=_headers(), timeout=30)
    resp.raise_for_status()
    return resp.json().get("data", {}).get("voices", [])

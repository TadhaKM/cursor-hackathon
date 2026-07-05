import asyncio
import json
import time

import httpx

from app import config


def _coerce_error(err) -> str | None:
    """HeyGen sometimes returns `error` as a structured object rather than a
    string. Normalize it so it fits VideoState.error (Optional[str])."""
    if err is None:
        return None
    if isinstance(err, str):
        return err
    try:
        return json.dumps(err)
    except (TypeError, ValueError):
        return str(err)


class HeyGenError(Exception):
    pass


def _headers() -> dict:
    return {"X-Api-Key": config.HEYGEN_API_KEY, "Content-Type": "application/json"}


async def submit_video(script: str, client: httpx.AsyncClient, voice_id: str | None = None) -> str:
    """Submit one HeyGen video generation job, return its video_id.

    voice_id overrides config.HEYGEN_VOICE_ID when set — used for the
    cloned-voice mode (see clone_voice_from_base64/poll_voice_clone below):
    a cloned voice's ID works as a normal HeyGen voice_id in this same
    text-to-speech path, no separate audio-track plumbing needed.
    """
    if not config.HEYGEN_AVATAR_ID:
        raise HeyGenError("HEYGEN_AVATAR_ID must be set — pick one from GET /avatars first.")

    resolved_voice_id = voice_id or config.HEYGEN_VOICE_ID
    if not resolved_voice_id:
        raise HeyGenError("HEYGEN_VOICE_ID must be set — pick one from GET /voices first.")

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
                    "voice_id": resolved_voice_id,
                },
                "background": {"type": "color", "value": "#0b0b0f"},
            }
        ],
        "dimension": {"width": 1280, "height": 720},
        # Burn HeyGen's synced captions into the rendered video so the mp4 has
        # subtitles even outside our player (the frontend also shows its own).
        "caption": True,
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
        return {"status": "failed", "video_url": None, "error": _coerce_error(data.get("error"))}
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


async def render_section(
    title: str, script: str, client: httpx.AsyncClient, voice_id: str | None = None
) -> dict:
    """Submit + poll one section, with one retry if the render fails."""
    for attempt in range(2):
        try:
            video_id = await submit_video(script, client, voice_id=voice_id)
            result = await poll_until_done(video_id, client)
        except HeyGenError as exc:
            result = {"status": "failed", "video_url": None, "error": str(exc)}

        if result["status"] == "completed" or attempt == 1:
            return {"title": title, **result}
    return {"title": title, **result}


async def clone_voice_from_base64(
    voice_name: str, media_type: str, base64_data: str, client: httpx.AsyncClient
) -> str:
    """Submit a HeyGen native voice clone (POST /v3/voices/clone). Returns a
    voice_clone_id — poll it with poll_voice_clone until it's ready.

    Confirmed against HeyGen's actual v3 docs (developers.heygen.com/reference/
    clone-a-voice) and tested live: a real call with a bogus audio URL
    returned 200 (not the documented 403 "plan upgrade required"), so this
    account's plan does allow it. Real cost per clone is still unconfirmed —
    HeyGen's pricing page lists a flat $1.00 per Digital Twin API call, but
    it's not confirmed whether that figure also applies to this endpoint.
    """
    payload = {
        "voice_name": voice_name,
        "audio": {"type": "base64", "media_type": media_type, "data": base64_data},
    }
    resp = await client.post(
        f"{config.HEYGEN_BASE_URL}/v3/voices/clone",
        headers=_headers(),
        json=payload,
        timeout=30,
    )
    if resp.status_code == 403:
        raise HeyGenError("Voice cloning requires a HeyGen plan upgrade (403).")
    if resp.status_code >= 400:
        raise HeyGenError(f"HeyGen voice clone failed ({resp.status_code}): {resp.text}")

    voice_clone_id = resp.json().get("data", {}).get("voice_clone_id")
    if not voice_clone_id:
        raise HeyGenError(f"HeyGen clone response missing voice_clone_id: {resp.text}")
    return voice_clone_id


async def poll_voice_clone(voice_clone_id: str, client: httpx.AsyncClient) -> str:
    """Poll a HeyGen voice clone job until it's ready. Returns the voice_id
    (same value as voice_clone_id, per HeyGen's response) once complete."""
    start = time.monotonic()
    while True:
        resp = await client.get(
            f"{config.HEYGEN_BASE_URL}/v3/voices/{voice_clone_id}",
            headers=_headers(),
            timeout=15,
        )
        if resp.status_code >= 400:
            raise HeyGenError(f"HeyGen voice clone status check failed ({resp.status_code}): {resp.text}")

        data = resp.json().get("data", {})
        status = data.get("status")
        if status == "complete":
            return data.get("voice_id", voice_clone_id)
        if status == "failed":
            raise HeyGenError(f"HeyGen voice clone failed: {data.get('failure_message')}")

        if time.monotonic() - start >= config.VOICE_CLONE_MAX_WAIT_S:
            raise HeyGenError("Timed out waiting for HeyGen voice clone to complete.")
        await asyncio.sleep(config.VOICE_CLONE_POLL_INTERVAL_S)


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

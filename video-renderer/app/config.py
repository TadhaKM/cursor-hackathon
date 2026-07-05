import os

from dotenv import load_dotenv

load_dotenv()

# Mock mode: skip HeyGen entirely and return instant placeholder videos. Lets
# the full pipeline (and the real diagram) run without HeyGen credits.
MOCK_VIDEO = os.getenv("MOCK_VIDEO", "false").lower() == "true"

HEYGEN_API_KEY = os.getenv("HEYGEN_API_KEY", "")
HEYGEN_AVATAR_ID = os.getenv("HEYGEN_AVATAR_ID", "")
HEYGEN_VOICE_ID = os.getenv("HEYGEN_VOICE_ID", "")

# Absolute base URL for building diagram image links. Prefer an explicit
# PUBLIC_BASE_URL; on Render, fall back to the auto-provided RENDER_EXTERNAL_URL
# so deploys work without manual configuration.
PUBLIC_BASE_URL = (
    os.getenv("PUBLIC_BASE_URL")
    or os.getenv("RENDER_EXTERNAL_URL")
    or "http://localhost:8000"
).rstrip("/")

HEYGEN_BASE_URL = "https://api.heygen.com"
KROKI_BASE_URL = "https://kroki.io"

# Polling schedule per the spec: every 5s for the first 30s, then every 15s,
# capped at 5 minutes total per video.
POLL_FAST_INTERVAL_S = 5
POLL_FAST_WINDOW_S = 30
POLL_SLOW_INTERVAL_S = 15
POLL_MAX_WAIT_S = 300

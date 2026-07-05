import os

from dotenv import load_dotenv

load_dotenv()

HEYGEN_API_KEY = os.getenv("HEYGEN_API_KEY", "")
HEYGEN_AVATAR_ID = os.getenv("HEYGEN_AVATAR_ID", "")
HEYGEN_VOICE_ID = os.getenv("HEYGEN_VOICE_ID", "")

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")

HEYGEN_BASE_URL = "https://api.heygen.com"
KROKI_BASE_URL = "https://kroki.io"

# Polling schedule per the spec: every 5s for the first 30s, then every 15s,
# capped at 5 minutes total per video.
POLL_FAST_INTERVAL_S = 5
POLL_FAST_WINDOW_S = 30
POLL_SLOW_INTERVAL_S = 15
POLL_MAX_WAIT_S = 300

"""Shared model + session config for all Randy agents.

Extracted to avoid circular imports: specialists and the orchestrator both
need the same Gemini model and sanitised session IDs.
"""

import os
import re

from dotenv import load_dotenv
from strands.models.gemini import GeminiModel

load_dotenv()

model = GeminiModel(
    client_args={
        "api_key": os.environ["GEMINI_API_KEY"],
    },
    model_id="gemini-3.6-flash",
    params={
        "temperature": 0.2,
        "max_output_tokens": 8192,
    },
)

# File-backed session storage (one dir per extension session_id).
SESSION_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".randy_sessions",
)

MAX_DESCRIPTION_CHARS = 15000


def sanitize_session_id(session_id):
    """Allowlist session IDs for FileSessionManager (no path separators).

    The extension sends UUIDs; anything else falls back to "default" so a
    hostile/malformed ID can never escape the storage dir.
    """
    if isinstance(session_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session_id):
        return session_id
    return "default"

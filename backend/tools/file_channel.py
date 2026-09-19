"""File channel — session-id-keyed pending file handoff.

The cover-letter tool compiles a PDF to disk. The HTTP handler needs the
bytes without going through LLM text output. The Strands Agent sync bridge
uses `contextvars.copy_context()` + ThreadPoolExecutor, so a plain
ContextVar set inside a tool is isolated from the Flask parent thread.
We therefore key pending files by session_id (stable across threads)
with a lock for concurrent Flask workers.

Flows:
  handler: agent(prompt, invocation_state={"session_id": sid})
    -> ToolContext.invocation_state["session_id"] available in tool
    -> set_pending_file(..., session_id=sid)
  handler after agent returns: pop_pending_file(session_id=sid)
"""

import os
import threading

# Authoritative store: session_id -> {path, filename, mime_type}
_pending_by_session: dict[str, dict] = {}
_lock = threading.Lock()

# Fallback ContextVar for local tests / non-session paths (kept for compat)
import contextvars as _cv
_fallback_ctx: _cv.ContextVar = _cv.ContextVar("_pending_file_fallback", default=None)


import re as _re

def _sanitize_sid(session_id) -> str:
    if isinstance(session_id, str) and _re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session_id.strip()):
        return session_id.strip()
    if isinstance(session_id, str) and session_id.strip():
        # Fall back to default for hostile/malformed IDs (mirrors agents.common.sanitize_session_id)
        return "default"
    return "default"


def set_pending_file(path: str, filename: str = None, mime_type: str = "application/pdf", session_id: str = None):
    """Store pending file info keyed by session_id (and fallback ContextVar)."""
    if not path:
        return
    abs_path = os.path.abspath(path) if not os.path.isabs(path) else path
    if not filename:
        filename = os.path.basename(abs_path)
    info = {
        "path": abs_path,
        "filename": filename,
        "mime_type": mime_type or "application/pdf",
    }
    # Always set fallback for direct ContextVar tests
    _fallback_ctx.set(info)
    sid = _sanitize_sid(session_id) if session_id is not None else None
    # If session_id provided, key by it; otherwise also store under "default"
    # so pop without session still works in simple single-user dev.
    if sid is not None:
        with _lock:
            _pending_by_session[sid] = info
    else:
        with _lock:
            _pending_by_session["default"] = info


def pop_pending_file(session_id: str = None):
    """Retrieve and clear the pending file for the given session_id.

    If session_id is provided, pops that session's entry.
    If None, tries fallback ContextVar first, then "default" dict entry.
    """
    # Session-keyed path (primary) — strict isolation by session
    if session_id is not None:
        sid = _sanitize_sid(session_id)
        with _lock:
            val = _pending_by_session.pop(sid, None)
        if val is not None:
            # clear fallback if it matches (cleanup)
            try:
                if _fallback_ctx.get() == val:
                    _fallback_ctx.set(None)
            except Exception:
                pass
            return val
        return None

    # No session: try ContextVar first
    try:
        fb = _fallback_ctx.get()
    except Exception:
        fb = None
    if fb is not None:
        _fallback_ctx.set(None)
        with _lock:
            _pending_by_session.pop("default", None)
            # also pop any sanitized default that matches
        return fb
    # Fallback to default dict entry (for tools that used session_id=None)
    with _lock:
        return _pending_by_session.pop("default", None)


def peek_pending_file(session_id: str = None):
    """Non-destructive peek (for testing)."""
    if session_id is not None:
        sid = _sanitize_sid(session_id)
        with _lock:
            val = _pending_by_session.get(sid)
        if val is not None:
            return val
        return _fallback_ctx.get()
    fb = _fallback_ctx.get()
    if fb is not None:
        return fb
    with _lock:
        return _pending_by_session.get("default")

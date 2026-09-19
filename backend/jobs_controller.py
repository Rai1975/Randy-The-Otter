import logging
import random

from flask import Blueprint, request, jsonify

from agents.randy_main import get_randy_agent

jobs_bp = Blueprint("jobs", __name__)

logger = logging.getLogger(__name__)

# Bound how much description text we hand the agent per call.
MAX_DESCRIPTION_CHARS = 15000

# Probability an ambient job sighting (dwell scrape) gets a comment.
# Explicit pokes (trigger == "click") always comment. Gating happens before
# the agent call, so misses cost nothing.
JOB_COMMENT_PROBABILITY = 0.60

AGENT_FALLBACK_REPLY = "bro my brain glitched, say that again?"
NO_DESCRIPTION_REPLY = "bro there's no description on this one."


def _agent_reply(session_id, description):
    """Ask the session-scoped Randy agent to react to a job description.

    Only the description string reaches the agent — never the full job
    envelope. Memory is keyed by session_id via FileSessionManager.
    Returns a fallback bubble string instead of raising, so the extension
    always gets renderable text.
    """
    text = (description or "").strip()
    if not text:
        return NO_DESCRIPTION_REPLY
    try:
        agent = get_randy_agent(session_id)
        result = agent(text[:MAX_DESCRIPTION_CHARS])
        reply = str(result).strip()
        return reply or AGENT_FALLBACK_REPLY
    except Exception:
        logger.exception("Randy agent call failed")
        return AGENT_FALLBACK_REPLY


def _build_reply(envelope):
    """Build the backend-driven bubble text for an envelope.

    Returns (reply, show): `show` tells the extension whether to bring up
    the chat bubble at all. Direct interactions (greeting/click/answer)
    always show; ambient `job` sightings only comment randomly (explicit
    click-triggered jobs always do), otherwise reply is None and the bubble
    stays invisible.
    """
    session_id = envelope.get("session_id")
    event_type = envelope.get("type")
    job = envelope.get("job")
    answer = envelope.get("answer")

    short_session = str(session_id)[:8] if session_id else "no-session"

    if event_type == "greeting":
        return f"HEY! Randy here — session {short_session}. Click me or keep browsing jobs!", True
    if event_type == "click":
        return f"Whoa, hi! Still session {short_session} — show me a job posting!", True
    if event_type == "answer":
        return f"Got it ({answer})! Logged under session {short_session}.", True
    job_payload = None
    if event_type == "job" and isinstance(job, dict):
        job_payload = job
    elif isinstance(job, dict) and (job.get("title") or job.get("jobId")):
        # Back-compat: legacy callers that POST raw job JSON without envelope.
        job_payload = job
    if job_payload is not None:
        if (
            envelope.get("trigger") == "click"
            or random.random() < JOB_COMMENT_PROBABILITY
        ):
            return _agent_reply(session_id, job_payload.get("description")), True
        return None, False
    return f"Randy echo — session {short_session}.", True


def _is_question(envelope):
    """Whether this reply asks the user a Yes/No question.

    Default False for now — the extension hides the Yes/No buttons unless
    the backend explicitly sets this True. Future Strands agent logic will
    decide per-reply; keep the decision in this single helper.
    """
    return False


@jobs_bp.route("/job-summary", methods=["POST"])
def job_summary():
    """Echo back the received JSON packet with session support.

    Expects: Content-Type: application/json with any JSON object body.
    Session-aware envelope: { session_id, type, job?, answer? }.
    Legacy raw job JSON bodies still work (session_id echoes as None).

    Returns: echo + session_id + reply (bubble text, None when silent) +
    show (whether to bring up the bubble at all) + is_question
    (whether to show Yes/No buttons) + request_id.
    The extension must render `reply` — never hardcoded strings — and
    keep the bubble invisible unless show is true.
    """
    if not request.is_json:
        return jsonify({
            "error": "Bad Request",
            "message": "Request body must be JSON",
            "request_id": getattr(request, "request_id", None),
        }), 400

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({
            "error": "Bad Request",
            "message": "Malformed JSON body",
            "request_id": getattr(request, "request_id", None),
        }), 400

    envelope = data if isinstance(data, dict) else {}

    reply, show = _build_reply(envelope)

    return jsonify({
        "echo": data,
        "session_id": envelope.get("session_id"),
        "reply": reply,
        "show": show,
        "is_question": _is_question(envelope),
        "request_id": getattr(request, "request_id", None),
    }), 200

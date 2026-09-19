from flask import Blueprint, request, jsonify

jobs_bp = Blueprint("jobs", __name__)


def _build_reply(envelope):
    """Build the backend-driven bubble text for an envelope.

    Echo-only for now: reflects session_id / type / job so the extension
    can render backend text. Persistent conversation memory lives on the
    future AWS Strands side, keyed by session_id.
    """
    session_id = envelope.get("session_id")
    event_type = envelope.get("type")
    job = envelope.get("job")
    answer = envelope.get("answer")

    short_session = str(session_id)[:8] if session_id else "no-session"

    if event_type == "greeting":
        return f"HEY! Randy here — session {short_session}. Click me or keep browsing jobs!"
    if event_type == "click":
        return f"Whoa, hi! Still session {short_session} — show me a job posting!"
    if event_type == "answer":
        return f"Got it ({answer})! Logged under session {short_session}."
    if event_type == "job" and isinstance(job, dict):
        title = job.get("title") or "this role"
        company = job.get("company") or "that company"
        return f"Ooh, {title} at {company}? Session {short_session} is watching!"
    if isinstance(job, dict) and (job.get("title") or job.get("jobId")):
        # Back-compat: legacy callers that POST raw job JSON without envelope.
        title = job.get("title") or "this role"
        return f"Ooh, {title}? Session {short_session} is watching!"
    return f"Randy echo — session {short_session}."


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

    Returns: echo + session_id + reply (bubble text) + is_question
    (whether to show Yes/No buttons) + request_id.
    The extension must render `reply` — never hardcoded strings.
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

    return jsonify({
        "echo": data,
        "session_id": envelope.get("session_id"),
        "reply": _build_reply(envelope),
        "is_question": _is_question(envelope),
        "request_id": getattr(request, "request_id", None),
    }), 200

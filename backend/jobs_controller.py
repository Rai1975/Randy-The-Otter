import base64
import csv
import math
import logging
import os
import random
import threading
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify

from agents.randy_main import generate_cover_letter_for_job, generate_match_score_for_job, get_randy_agent
from agents.common import sanitize_session_id
from tools.file_channel import bind_file_session, pop_pending_file, reset_file_session

jobs_bp = Blueprint("jobs", __name__)

logger = logging.getLogger(__name__)

from agents.common import MAX_DESCRIPTION_CHARS

# Probability an ambient job sighting (dwell scrape) gets a comment.
# Explicit triggers (click, roast, cover-letter, match-score) always
# comment. Gating happens before the agent call, so misses cost nothing.
JOB_COMMENT_PROBABILITY = 0.60
EXPLICIT_TRIGGERS = {"click", "roast", "cover-letter", "match-score"}

# Backend-driven snarky reply for Roast with no posting on screen.
ROAST_NO_JOB_REPLY = "what do you want me to roast? i dont see anything man"

AGENT_FALLBACK_REPLY = "bro my brain glitched, say that again?"
NO_DESCRIPTION_REPLY = "bro there's no description on this one."

# Menu actions that bypass the random gate and expect a real reply even
# without a job description in other contexts.
ACTION_BYPASS_NO_DESC = {"roast"}

APPLIED_JOBS_CSV = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "applied_jobs.csv"
)
APPLIED_JOBS_FIELDNAMES = ["applied_at", "source", "job_id", "title", "company"]
# Single-line text cap for title/company — keeps the CSV readable and guards
# pathological GraphQL strings. Applied at write time, never raises.
APPLIED_JOB_TEXT_MAX_CHARS = 300
_applied_jobs_lock = threading.Lock()
APPLIED_QUESTION_TEMPLATE_TITLED = 'did you apply to "{title}"?'
APPLIED_QUESTION_TEMPLATE_GENERIC = "did you apply to that one?"
APPLIED_YES_REPLY = "logged bro, good luck!"
APPLIED_NO_REPLY = "all good, lmk if you want me to roast the next one"
APPLIED_INVALID_REPLY = "my bad, couldn't log that one — try again?"


def _applied_jobs_key(source, job_id):
    """Normalise the dedupe key (source, job_id) -> tuple of strings."""
    return (str(source or "").strip(), str(job_id or "").strip())


def _clean_applied_job_text(value):
    """Normalise a free-text CSV field: single-line, stripped, capped."""
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    if len(text) > APPLIED_JOB_TEXT_MAX_CHARS:
        text = text[:APPLIED_JOB_TEXT_MAX_CHARS].rstrip()
    return text


def _append_applied_job(source, job_id, title=None, company=None):
    """Append one row to data/applied_jobs.csv; dedupe on (source, job_id).

    Stores applied_at, source (portal), job_id, title, company. No
    description is stored by design. A stale/foreign header (e.g. the old
    3-column file) is replaced fresh — old rows are dropped, not migrated.

    Returns True when a new row was written, False when deduped. Never
    raises — the caller maps failures to a user-facing reply.
    """
    key = _applied_jobs_key(source, job_id)
    if not key[0] or not key[1]:
        return False
    title = _clean_applied_job_text(title)
    company = _clean_applied_job_text(company)
    try:
        with _applied_jobs_lock:
            os.makedirs(os.path.dirname(APPLIED_JOBS_CSV), exist_ok=True)
            existing = set()
            needs_header = True
            if os.path.exists(APPLIED_JOBS_CSV) and os.path.getsize(APPLIED_JOBS_CSV) > 0:
                with open(APPLIED_JOBS_CSV, newline="", encoding="utf-8") as f:
                    reader = csv.DictReader(f)
                    if reader.fieldnames == APPLIED_JOBS_FIELDNAMES:
                        needs_header = False
                        for row in reader:
                            existing.add(_applied_jobs_key(row.get("source"), row.get("job_id")))
                    # else: stale header — fall through and rewrite fresh below
            if key in existing:
                return False
            mode = "a" if not needs_header else "w"
            # needs_header is True for missing/empty/stale files; "w" writes
            # a clean header first. Otherwise append to the matching file.
            # Stale-header rewrite must happen inside the lock: re-check via
            # needs_header computed above from the same locked read.
            with open(APPLIED_JOBS_CSV, mode, newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=APPLIED_JOBS_FIELDNAMES)
                if needs_header:
                    writer.writeheader()
                writer.writerow({
                    "applied_at": datetime.now(timezone.utc).isoformat(),
                    "source": key[0],
                    "job_id": key[1],
                    "title": title,
                    "company": company,
                })
            return True
    except Exception:
        logger.exception("Failed to append applied job %s", key)
        return False


def _normalize_preferences(raw):
    """Accept only a small, bounded preference snapshot from the extension."""
    if not isinstance(raw, dict):
        return {}

    def clean_list(value, allowed=None, limit=20):
        if not isinstance(value, list):
            return []
        result = []
        for item in value[:limit]:
            if not isinstance(item, str):
                continue
            item = item.strip()[:120]
            if item and (allowed is None or item in allowed) and item not in result:
                result.append(item)
        return result

    pay = raw.get("pay") if isinstance(raw.get("pay"), dict) else {}
    normalized_pay = {"currency": pay.get("currency") if pay.get("currency") in {"USD", "CAD", "EUR", "GBP"} else "USD"}
    for key in ("min", "max"):
        value = pay.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            normalized_pay[key] = value

    locations = raw.get("locations") if isinstance(raw.get("locations"), dict) else {}
    custom_locations = clean_list(locations.get("custom"))
    custom_selected = clean_list(locations.get("customSelected"))
    return {
        "version": 1,
        "sponsorship": raw.get("sponsorship") if raw.get("sponsorship") in {"any", "preferred", "required"} else "any",
        "pay": normalized_pay,
        "locations": {
            "presets": clean_list(locations.get("presets")),
            "custom": custom_locations,
            "customSelected": [location for location in custom_selected if location in custom_locations],
            "remote": locations.get("remote") is True,
        },
        "titles": clean_list(raw.get("titles")),
        "opportunityTypes": clean_list(raw.get("opportunityTypes"), {"internship", "full_time"}),
    }


def _agent_reply(session_id, description, action=None, preferences=None):
    """Ask the session-scoped Randy orchestrator to react to a job description.

    Only the description string reaches the agent — never the full job
    envelope. For explicit menu actions the description is tagged
    "[action: <action>]" so the orchestrator delegates to the right specialist
    tool; ambient sightings pass the raw description and the orchestrator
    reacts directly. Memory is keyed by session_id via FileSessionManager.
    Returns (reply, payload): payload is normally None; cover-letter PDF is
    handled via the file_channel ContextVar and attached by the HTTP handler
    (payload.file with base64), not via LLM text output.
    """
    text = (description or "").strip()
    if not text:
        # Roast handles its own empty case via its prompt; other empties
        # are caught here to avoid a wasted model call.
        if action == "roast":
            pass  # let the roast specialist produce its snarky line
        else:
            return NO_DESCRIPTION_REPLY, None
    # Tag explicit actions so the orchestrator's routing prompt can dispatch.
    prompt = f"[action: {action}]\n{text}" if action else text
    prompt = prompt[: MAX_DESCRIPTION_CHARS + 64] if len(prompt) > MAX_DESCRIPTION_CHARS else prompt
    try:
        if action == "cover-letter":
            # This is a deterministic menu action, not a conversational
            # decision. Invoke its specialist directly so the session ID
            # reaches generate_cover_letter in one agent call.
            raw = generate_cover_letter_for_job(session_id, text).strip()
            return raw or AGENT_FALLBACK_REPLY, None
        if action == "match-score":
            raw = generate_match_score_for_job(session_id, text, preferences).strip()
            return raw or AGENT_FALLBACK_REPLY, None
        agent = get_randy_agent(session_id)
        # Pass session_id via invocation_state so downstream tools can key the file channel
        # (Strands sync bridge uses copy_context + ThreadPoolExecutor, so ContextVar alone is isolated)
        try:
            result = agent(prompt, invocation_state={"session_id": session_id})
        except TypeError:
            # Fallback for older Strands signature without invocation_state
            result = agent(prompt)
        raw = str(result).strip()
        if not raw:
            return AGENT_FALLBACK_REPLY, None
        return raw, None
    except Exception:
        logger.exception("Randy agent call failed (action=%s)", action)
        return AGENT_FALLBACK_REPLY, None


def _build_reply(envelope):
    """Build the backend-driven bubble text for an envelope.

    Returns (reply, show, payload): `show` tells the extension whether to
    bring up the bubble; `payload` carries large outputs like LaTeX that
    don't fit in the bubble (cover-letter).
    """
    session_id = envelope.get("session_id")
    event_type = envelope.get("type")
    job = envelope.get("job")
    answer = envelope.get("answer")
    action = envelope.get("action")
    trigger = envelope.get("trigger")
    preferences = _normalize_preferences(envelope.get("preferences"))
    # Canonical explicit action: `action` (new) or legacy `trigger`.
    explicit_action = action or (trigger if trigger in EXPLICIT_TRIGGERS else None)

    short_session = str(session_id)[:8] if session_id else "no-session"

    if event_type == "greeting":
        return f"HEY! Randy here — session {short_session}. Click me or keep browsing jobs!", True, None
    if event_type == "job-switch":
        prev = envelope.get("previous_job")
        title = (prev.get("title") if isinstance(prev, dict) else None) or ""
        title = title.strip()
        # Keep the question short; truncate pathological titles.
        if len(title) > 80:
            title = title[:77] + "…"
        question = (
            APPLIED_QUESTION_TEMPLATE_TITLED.format(title=title)
            if title
            else APPLIED_QUESTION_TEMPLATE_GENERIC
        )
        return question, True, None
    if event_type == "answer":
        about = envelope.get("about_job")
        normalized = (answer or "").strip().lower()
        if normalized == "yes":
            if isinstance(about, dict):
                ok = _append_applied_job(
                    about.get("source") or about.get("site"),
                    about.get("job_id") or about.get("jobId"),
                    about.get("title"),
                    about.get("company"),
                )
                # Deduped is still an ack — user already applied.
                return (APPLIED_YES_REPLY if ok else APPLIED_YES_REPLY), True, None
            return APPLIED_INVALID_REPLY, True, None
        if normalized == "no":
            return APPLIED_NO_REPLY, True, None
        return f"Got it ({answer})! Logged under session {short_session}.", True, None
    # Job channel: explicit menu actions bypass the random gate; ambient
    # sightings are gated.
    if event_type == "job":
        has_job = isinstance(job, dict)
        description = job.get("description") if has_job else None
        is_explicit = explicit_action in EXPLICIT_TRIGGERS
        should_comment = is_explicit or random.random() < JOB_COMMENT_PROBABILITY
        if not should_comment:
            return None, False, None
        if not has_job:
            # No posting on screen — only roast has a dedicated snark.
            if explicit_action == "roast":
                return ROAST_NO_JOB_REPLY, True, None
            return f"Randy echo — session {short_session}.", True, None
        # Route through orchestrator; description-only reaches the agent.
        reply, payload = _agent_reply(session_id, description, action=explicit_action, preferences=preferences)
        return reply, True, payload
    if isinstance(job, dict) and (job.get("title") or job.get("jobId")):
        # Back-compat: legacy callers that POST raw job JSON without envelope.
        if random.random() < JOB_COMMENT_PROBABILITY:
            reply, payload = _agent_reply(session_id, job.get("description"))
            return reply, True, payload
        return None, False, None
    return f"Randy echo — session {short_session}.", True, None


def _is_question(envelope):
    """Whether this reply asks the user a Yes/No question."""
    if envelope.get("type") == "job-switch":
        return True
    return False


@jobs_bp.route("/job-summary", methods=["POST"])
def job_summary():
    """Echo back the received JSON packet with session support.

    Expects: Content-Type: application/json with any JSON object body.
    Session-aware envelope: { session_id, type, job?, answer? }.
    Legacy raw job JSON bodies still work (session_id echoes as None).

    Returns: echo + session_id + reply (bubble text, None when silent) +
    show (whether to bring up the bubble) + is_question + payload
    (LaTeX for cover-letter, else null) + request_id.
    The extension must render `reply` — never hardcoded strings — and
    keep the bubble invisible unless show is true. Large outputs live in
    payload (extension console.logs it for now; future: pdf download).
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

    # Bind the canonical key before Strands starts worker threads. The
    # file-producing nested specialist can inherit this read-only context even
    # if an agent-as-tool boundary drops its invocation_state.
    sid = sanitize_session_id(envelope.get("session_id"))
    session_token = bind_file_session(sid)
    try:
        reply, show, payload = _build_reply(envelope)
    finally:
        reset_file_session(session_token)

    # File channel: if a cover-letter tool set a pending file during the
    # agent call, attach it as base64 payload.file and suppress bubble text.
    # Key by session_id because Strands executes tools on a different
    # thread/context (copy_context + ThreadPoolExecutor).
    try:
        pending = pop_pending_file(session_id=sid)
    except Exception:
        logger.exception("pop_pending_file failed")
        pending = None

    if pending:
        try:
            file_path = pending.get("path")
            if file_path and os.path.exists(file_path):
                with open(file_path, "rb") as f:
                    file_bytes = f.read()
                data_b64 = base64.b64encode(file_bytes).decode("utf-8")
                payload = {
                    "file": {
                        "data_base64": data_b64,
                        "filename": pending.get("filename") or os.path.basename(file_path),
                        "mime_type": pending.get("mime_type") or "application/pdf",
                    }
                }
                # Cover-letter is silent: no bubble text, no bubble
                explicit_action = envelope.get("action") or (
                    envelope.get("trigger") if envelope.get("trigger") in EXPLICIT_TRIGGERS else None
                )
                if explicit_action == "cover-letter":
                    reply = None
                    show = False
                # Delete PDF after encoding (user requested cleanup)
                try:
                    os.remove(file_path)
                except Exception:
                    logger.warning("Failed to delete PDF after encoding: %s", file_path)
            else:
                logger.warning("Pending file not found on disk: %s", pending)
        except Exception:
            logger.exception("Failed to encode pending file %s", pending)

    return jsonify({
        "echo": data,
        "session_id": envelope.get("session_id"),
        "reply": reply,
        "show": show,
        "is_question": _is_question(envelope),
        "payload": payload,
        "request_id": getattr(request, "request_id", None),
    }), 200


@jobs_bp.route("/applied-jobs", methods=["GET"])
def applied_jobs():
    """Return the application tracker rows sourced only from applied_jobs.csv."""
    rows = []
    try:
        if os.path.exists(APPLIED_JOBS_CSV):
            with open(APPLIED_JOBS_CSV, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                if reader.fieldnames == APPLIED_JOBS_FIELDNAMES:
                    rows = [
                        {
                            "applied_at": row.get("applied_at", ""),
                            "source": row.get("source", ""),
                            "job_id": row.get("job_id", ""),
                        }
                        for row in reader
                    ]
    except OSError:
        logger.exception("Failed to read applied jobs CSV")
        return jsonify({
            "error": "Could not read application history",
            "request_id": getattr(request, "request_id", None),
        }), 500

    return jsonify({
        "applications": rows,
        "source": "backend/data/applied_jobs.csv",
        "request_id": getattr(request, "request_id", None),
    }), 200

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
from tools.get_user_profile import get_autofill_profile

jobs_bp = Blueprint("jobs", __name__)

logger = logging.getLogger(__name__)

from agents.common import MAX_DESCRIPTION_CHARS

# Probability an ambient job sighting (dwell scrape) gets a comment.
# Explicit triggers (click, roast, cover-letter, match-score) always
# comment. Gating happens before the agent call, so misses cost nothing.
JOB_COMMENT_PROBABILITY = 0.60
# Of the ambient comments that do fire, the share that are a roast instead of
# the usual encouraging quip. Roast left the menu and lives here now — it is
# meant to be a surprise, so ~0.20 of 0.60 is about one roast per eight jobs.
ROAST_PROBABILITY = 0.20
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
APPLIED_JOBS_FIELDNAMES = ["applied_at", "source", "job_id", "title", "company", "status"]
# Strict lifecycle for the tracker. Stored lowercase; accepted
# case-insensitively at the API boundary, anything else is a 400.
APPLIED_JOB_STATUSES = ("applied", "rejected", "interview", "hired")
APPLIED_JOB_DEFAULT_STATUS = "applied"
# Older headers we can upgrade in place (rows preserved, gaps backfilled).
_APPLIED_JOBS_LEGACY_3COL = ["applied_at", "source", "job_id"]
_APPLIED_JOBS_LEGACY_5COL = ["applied_at", "source", "job_id", "title", "company"]
# Single-line text cap for title/company — keeps the CSV readable and guards
# pathological GraphQL strings. Applied at write time, never raises.
APPLIED_JOB_TEXT_MAX_CHARS = 300
_applied_jobs_lock = threading.Lock()
# Randy speaks in lowercase with no quoting anywhere else, so the scraped
# title is folded to match rather than dropped in verbatim as Title Case.
APPLIED_QUESTION_TEMPLATE_TITLED = "did you apply to {title}?"
# Scraped titles run long ("... CO-OP - Information Services Spring 27"). At
# 10px in a 256px bubble that is ~25 chars a line, so cap it tighter than the
# CSV limit — this only shortens the question, never what gets logged.
APPLIED_QUESTION_MAX_TITLE_CHARS = 45
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


def _normalize_applied_job_status(value):
    """Normalise a status string -> lowercase enum member, or None if invalid."""
    text = str(value or "").strip().lower()
    return text if text in APPLIED_JOB_STATUSES else None


def _applied_job_record(row):
    """Coerce a raw CSV dict into the current schema (backfills gaps).

    Missing/blank title/company become "", missing/invalid status becomes
    the default. applied_at is preserved verbatim.
    """
    row = row if isinstance(row, dict) else {}
    key = _applied_jobs_key(row.get("source"), row.get("job_id"))
    return {
        "applied_at": str(row.get("applied_at") or ""),
        "source": key[0],
        "job_id": key[1],
        "title": _clean_applied_job_text(row.get("title")),
        "company": _clean_applied_job_text(row.get("company")),
        "status": _normalize_applied_job_status(row.get("status")) or APPLIED_JOB_DEFAULT_STATUS,
    }


def _read_applied_job_rows():
    """Read all tracker rows in file order, coerced to the current schema.

    Never mutates the file: missing/empty/foreign files yield []. Callers
    must hold _applied_jobs_lock.
    """
    if not os.path.exists(APPLIED_JOBS_CSV) or os.path.getsize(APPLIED_JOBS_CSV) == 0:
        return []
    with open(APPLIED_JOBS_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames == APPLIED_JOBS_FIELDNAMES:
            return [_applied_job_record(row) for row in reader]
        if fieldnames in (_APPLIED_JOBS_LEGACY_3COL, _APPLIED_JOBS_LEGACY_5COL):
            # Older schema — same coercion backfills title/company/status.
            return [_applied_job_record(row) for row in reader]
        return []


def _write_applied_job_rows(rows):
    """Atomically rewrite the whole tracker file (tmp + replace).

    Callers must hold _applied_jobs_lock.
    """
    os.makedirs(os.path.dirname(APPLIED_JOBS_CSV), exist_ok=True)
    tmp_path = APPLIED_JOBS_CSV + ".tmp"
    with open(tmp_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=APPLIED_JOBS_FIELDNAMES)
        writer.writeheader()
        for row in rows or []:
            record = _applied_job_record(row)
            if record["source"] and record["job_id"]:
                writer.writerow(record)
    os.replace(tmp_path, APPLIED_JOBS_CSV)


def _append_applied_job(source, job_id, title=None, company=None, status=None):
    """Append one row to data/applied_jobs.csv; dedupe on (source, job_id).

    Stores applied_at, source (portal), job_id, title, company, status. No
    description is stored by design. New rows default to status "applied".
    Recognized older headers are upgraded in place (rows preserved, gaps
    backfilled); foreign headers reset fresh.

    Returns True when a new row was written, False when deduped. Never
    raises — the caller maps failures to a user-facing reply.
    """
    key = _applied_jobs_key(source, job_id)
    if not key[0] or not key[1]:
        return False
    title = _clean_applied_job_text(title)
    company = _clean_applied_job_text(company)
    status = _normalize_applied_job_status(status) or APPLIED_JOB_DEFAULT_STATUS
    try:
        with _applied_jobs_lock:
            os.makedirs(os.path.dirname(APPLIED_JOBS_CSV), exist_ok=True)
            rows = []
            needs_rewrite = True
            if os.path.exists(APPLIED_JOBS_CSV) and os.path.getsize(APPLIED_JOBS_CSV) > 0:
                with open(APPLIED_JOBS_CSV, newline="", encoding="utf-8") as f:
                    reader = csv.DictReader(f)
                    if reader.fieldnames == APPLIED_JOBS_FIELDNAMES:
                        needs_rewrite = False
                        for row in reader:
                            rows.append(_applied_job_record(row))
                    elif reader.fieldnames in (_APPLIED_JOBS_LEGACY_3COL, _APPLIED_JOBS_LEGACY_5COL):
                        # Upgrade path — preserve rows, backfill gaps.
                        needs_rewrite = True
                        for row in reader:
                            rows.append(_applied_job_record(row))
                    # else: foreign header — drop rows, rewrite fresh below
            existing = {_applied_jobs_key(r.get("source"), r.get("job_id")) for r in rows}
            if key in existing:
                if needs_rewrite and rows:
                    _write_applied_job_rows(rows)
                elif needs_rewrite:
                    _write_applied_job_rows([])
                return False
            new_row = {
                "applied_at": datetime.now(timezone.utc).isoformat(),
                "source": key[0],
                "job_id": key[1],
                "title": title,
                "company": company,
                "status": status,
            }
            if needs_rewrite:
                _write_applied_job_rows(rows + [new_row])
            else:
                with open(APPLIED_JOBS_CSV, "a", newline="", encoding="utf-8") as f:
                    writer = csv.DictWriter(f, fieldnames=APPLIED_JOBS_FIELDNAMES)
                    writer.writerow(new_row)
            return True
    except Exception:
        logger.exception("Failed to append applied job %s", key)
        return False


def _find_applied_job_index(rows, source, job_id):
    """Index of the row matching (source, job_id), or None. Alias-aware."""
    key = _applied_jobs_key(source, job_id)
    for i, row in enumerate(rows or []):
        if _applied_jobs_key(row.get("source"), row.get("job_id")) == key:
            return i
    return None


def _applied_jobs_error(message, status_code):
    """JSON error matching the controller's {error, message, request_id} shape."""
    return jsonify({
        "error": "Bad Request" if status_code == 400 else "Not Found",
        "message": message,
        "request_id": getattr(request, "request_id", None),
    }), status_code


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
    personal = raw.get("personalInformation") if isinstance(raw.get("personalInformation"), dict) else {}
    race_options = {
        "",
        "Hispanic or Latino",
        "Not Hispanic or Latino",
        "American Indian or Alaska Native",
        "Asian",
        "Black or African American",
        "Native Hawaiian or Other Pacific Islander",
        "White",
        "Two or more races",
        "I do not wish to answer",
    }
    gender_options = {"", "Man", "Woman", "Non-binary", "Another gender identity", "I do not wish to answer"}

    def personal_text(key):
        value = personal.get(key)
        return value.strip()[:300] if isinstance(value, str) else ""

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
        "personalInformation": {
            "firstName": personal_text("firstName"),
            "lastName": personal_text("lastName"),
            "phoneNumber": personal_text("phoneNumber"),
            "email": personal_text("email"),
            "homeAddress": personal_text("homeAddress"),
            "linkedinUrl": personal_text("linkedinUrl"),
            "websiteUrl": personal_text("websiteUrl"),
            "veteranStatus": personal.get("veteranStatus") if personal.get("veteranStatus") in {"", "I am a protected veteran", "I am not a protected veteran", "I do not wish to answer"} else "",
            "disabilityStatus": personal.get("disabilityStatus") if personal.get("disabilityStatus") in {"", "Yes, I have a disability", "No, I do not have a disability", "I do not wish to answer"} else "",
            "race": personal.get("race") if personal.get("race") in race_options else "",
            "gender": personal.get("gender") if personal.get("gender") in gender_options else "",
        },
    }


def _agent_reply(session_id, description, action=None, preferences=None):
    """Ask the session-scoped Randy orchestrator to react to a job description.

    Only the description string reaches the agent — never the full job
    envelope. For explicit menu actions the description is tagged
    "[action: <action>]" so the orchestrator delegates to the right specialist
    tool; ambient sightings pass the raw description and the orchestrator
    reacts directly. Memory is keyed by session_id via FileSessionManager.
    Returns (reply, payload, match_score): payload is normally None; cover-letter PDF is
    handled via the file_channel ContextVar and attached by the HTTP handler
    (payload.file with base64), not via LLM text output. match_score is a dict
    matching MatchScoreResult when action == "match-score", else None.
    """
    text = (description or "").strip()
    if not text:
        # Roast handles its own empty case via its prompt; other empties
        # are caught here to avoid a wasted model call.
        if action == "roast":
            pass  # let the roast specialist produce its snarky line
        elif action == "match-score":
            # Structured fallback without LLM call
            ms = {
                "answer": "0% match — bro there's no description on this one",
                "avg_score": 0,
                "preferences_score": 0,
                "qualifications_score": 0,
                "works": ["no signal to evaluate"],
                "misses": ["no description provided"],
            }
            return ms["answer"], None, ms
        else:
            return NO_DESCRIPTION_REPLY, None, None
    # Tag explicit actions so the orchestrator's routing prompt can dispatch.
    prompt = f"[action: {action}]\n{text}" if action else text
    prompt = prompt[: MAX_DESCRIPTION_CHARS + 64] if len(prompt) > MAX_DESCRIPTION_CHARS else prompt
    try:
        if action == "cover-letter":
            # This is a deterministic menu action, not a conversational
            # decision. Invoke its specialist directly so the session ID
            # reaches generate_cover_letter in one agent call.
            # Preferences are REQUIRED (chrome.storage) — no env fallback.
            prefs = preferences
            if not isinstance(prefs, dict) or not isinstance(prefs.get("personalInformation"), dict):
                logger.warning("cover-letter via job-summary missing preferences — failing")
                return "bro set your info in settings first — missing personal info", None, None
            missing = [k for k in ("firstName", "lastName", "email", "phoneNumber", "homeAddress") if not isinstance(prefs["personalInformation"].get(k), str) or not prefs["personalInformation"].get(k).strip()]
            if missing:
                logger.warning("cover-letter preferences missing fields: %s", missing)
                return "bro fill out your address/phone/email in settings first", None, None
            raw = generate_cover_letter_for_job(session_id, text, preferences=prefs).strip()
            return raw or AGENT_FALLBACK_REPLY, None, None
        if action == "match-score":
            ms = generate_match_score_for_job(session_id, text, preferences)
            # ms is already a validated dict (see randy_main)
            answer = ms.get("answer") if isinstance(ms, dict) else str(ms).strip()
            if not answer:
                answer = AGENT_FALLBACK_REPLY
            return answer, None, ms if isinstance(ms, dict) else None
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
            return AGENT_FALLBACK_REPLY, None, None
        return raw, None, None
    except Exception:
        logger.exception("Randy agent call failed (action=%s)", action)
        if action == "match-score":
            ms = {
                "answer": AGENT_FALLBACK_REPLY,
                "avg_score": 50,
                "preferences_score": 50,
                "qualifications_score": 50,
                "works": ["try again"],
                "misses": ["model glitched"],
            }
            return ms["answer"], None, ms
        return AGENT_FALLBACK_REPLY, None, None


def _build_reply(envelope):
    """Build the backend-driven bubble text for an envelope.

    Returns (reply, show, payload, match_score): `show` tells the extension whether to
    bring up the bubble; `payload` carries large outputs like LaTeX that
    don't fit in the bubble (cover-letter). `match_score` is a dict matching
    MatchScoreResult when action == "match-score", else None.
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
        return f"HEY! Randy here — session {short_session}. Click me or keep browsing jobs!", True, None, None
    if event_type == "greenhouse-autofill":
        # Acknowledging native-field autofill does not need an agent hop.
        return "filled that out for you — go double check it 🦦", True, None, None
    if event_type == "job-switch":
        prev = envelope.get("previous_job")
        title = (prev.get("title") if isinstance(prev, dict) else None) or ""
        title = title.strip().lower()
        if len(title) > APPLIED_QUESTION_MAX_TITLE_CHARS:
            cut = title[: APPLIED_QUESTION_MAX_TITLE_CHARS - 1].rstrip()
            # Back off to a word boundary, but only when the slice actually
            # landed mid-word — otherwise a title that happened to end cleanly
            # would lose its last word for nothing.
            if not title[APPLIED_QUESTION_MAX_TITLE_CHARS - 1].isspace() and " " in cut:
                cut = cut.rsplit(" ", 1)[0].rstrip(" ,-")
            title = cut + "…"
        question = (
            APPLIED_QUESTION_TEMPLATE_TITLED.format(title=title)
            if title
            else APPLIED_QUESTION_TEMPLATE_GENERIC
        )
        return question, True, None, None
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
                ok = _append_applied_job(
                    about.get("source") or about.get("site"),
                    about.get("job_id") or about.get("jobId"),
                    about.get("title"),
                    about.get("company"),
                )
                # Deduped is still an ack — user already applied.
                return (APPLIED_YES_REPLY if ok else APPLIED_YES_REPLY), True, None, None
            return APPLIED_INVALID_REPLY, True, None, None
        if normalized == "no":
            return APPLIED_NO_REPLY, True, None, None
        return f"Got it ({answer})! Logged under session {short_session}.", True, None, None
    # Job channel: explicit menu actions bypass the random gate; ambient
    # sightings are gated.
    if event_type == "job":
        has_job = isinstance(job, dict)
        description = job.get("description") if has_job else None
        is_explicit = explicit_action in EXPLICIT_TRIGGERS
        should_comment = is_explicit or random.random() < JOB_COMMENT_PROBABILITY
        if not should_comment:
            return None, False, None, None
        if not has_job:
            # No posting on screen — only roast has a dedicated snark.
            if explicit_action == "roast":
                return ROAST_NO_JOB_REPLY, True, None, None
            return f"Randy echo — session {short_session}.", True, None, None
        # Ambient sightings can turn into a roast. Tagging the action reuses
        # the existing roast specialist via the orchestrator's "[action: roast]"
        # routing — no separate prompt. Explicit menu actions never roast.
        ambient_action = explicit_action
        if not is_explicit and random.random() < ROAST_PROBABILITY:
            ambient_action = "roast"
            try:
                request.randy_roast = True
            except RuntimeError:
                pass  # called outside a request context (tests)
        # Route through orchestrator; description-only reaches the agent.
        reply, payload, match_score = _agent_reply(session_id, description, action=ambient_action, preferences=preferences)
        return reply, True, payload, match_score
    if isinstance(job, dict) and (job.get("title") or job.get("jobId")):
        # Back-compat: legacy callers that POST raw job JSON without envelope.
        if random.random() < JOB_COMMENT_PROBABILITY:
            reply, payload, match_score = _agent_reply(session_id, job.get("description"))
            return reply, True, payload, match_score
        return None, False, None, None
    return f"Randy echo — session {short_session}.", True, None, None


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
        _built = _build_reply(envelope)
        # _build_reply now returns 4-tuple (reply, show, payload, match_score); legacy 3-tuple fallback
        if len(_built) == 4:
            reply, show, payload, match_score = _built
        else:
            reply, show, payload = _built
            match_score = None
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
        # Tells the extension to put Randy in his smug roast sprite for this
        # line. Set by the ambient roast gate in _build_reply.
        "roast": bool(getattr(request, "randy_roast", False)),
        "payload": payload,
        "match_score": match_score,
        "request_id": getattr(request, "request_id", None),
    }), 200

@jobs_bp.route("/profile", methods=["GET", "POST"])
def profile():
    """Return the explicit profile fields used by supported form autofill."""
    data = request.get_json(silent=True) if request.is_json else None
    raw_preferences = data.get("preferences") if isinstance(data, dict) else None
    preferences = {}
    if raw_preferences:
        try:
            preferences = _normalize_preferences(raw_preferences)
        except (TypeError, ValueError):
            preferences = {}
    return jsonify(get_autofill_profile(preferences)), 200


@jobs_bp.route("/applied-jobs", methods=["GET"])
def list_applied_jobs():
    """List tracked applications, oldest first.

    Query: ?status=<applied|rejected|interview|hired> filters (400 on
    invalid). Missing/blank stored statuses read back as "applied".
    Returns {jobs, count, request_id}. Never creates the file.
    """
    status_filter = request.args.get("status")
    normalized_filter = None
    if status_filter is not None:
        normalized_filter = _normalize_applied_job_status(status_filter)
        if normalized_filter is None:
            return _applied_jobs_error(
                f"Invalid status '{status_filter}'. Allowed: {', '.join(APPLIED_JOB_STATUSES)}.",
                400,
            )
    try:
        with _applied_jobs_lock:
            rows = _read_applied_job_rows()
    except Exception:
        logger.exception("Failed to read applied jobs")
        return jsonify({
            "error": "Internal Server Error",
            "request_id": getattr(request, "request_id", None),
        }), 500
    if normalized_filter is not None:
        rows = [r for r in rows if r.get("status") == normalized_filter]
    return jsonify({
        "jobs": rows,
        "count": len(rows),
        "request_id": getattr(request, "request_id", None),
    }), 200


@jobs_bp.route("/applied-jobs", methods=["PATCH"])
def update_applied_job():
    """Update one tracked application's status (status-only).

    Body: {source|site, job_id|jobId, status}. Status is validated
    against the strict enum (400 otherwise). Unknown key -> 404.
    Returns {job, request_id}.
    """
    if not request.is_json:
        return _applied_jobs_error("Request body must be JSON.", 400)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _applied_jobs_error("Malformed JSON body.", 400)
    source = data.get("source") or data.get("site")
    job_id = data.get("job_id") or data.get("jobId")
    key = _applied_jobs_key(source, job_id)
    if not key[0] or not key[1]:
        return _applied_jobs_error("source and job_id are required.", 400)
    if data.get("status") is None:
        return _applied_jobs_error(
            f"status is required. Allowed: {', '.join(APPLIED_JOB_STATUSES)}.", 400)
    normalized = _normalize_applied_job_status(data.get("status"))
    if normalized is None:
        return _applied_jobs_error(
            f"Invalid status '{data.get('status')}'. Allowed: {', '.join(APPLIED_JOB_STATUSES)}.",
            400,
        )
    try:
        with _applied_jobs_lock:
            rows = _read_applied_job_rows()
            index = _find_applied_job_index(rows, key[0], key[1])
            if index is None:
                return jsonify({
                    "error": "Not Found",
                    "message": f"No tracked job for source '{key[0]}' job_id '{key[1]}'.",
                    "request_id": getattr(request, "request_id", None),
                }), 404
            rows[index]["status"] = normalized
            _write_applied_job_rows(rows)
            updated = rows[index]
    except Exception:
        logger.exception("Failed to update applied job %s", key)
        return jsonify({
            "error": "Internal Server Error",
            "request_id": getattr(request, "request_id", None),
        }), 500
    return jsonify({
        "job": updated,
        "request_id": getattr(request, "request_id", None),
    }), 200


@jobs_bp.route("/applied-jobs", methods=["DELETE"])
def delete_applied_job():
    """Delete one tracked application by (source, job_id).

    Accepts a JSON body {source|site, job_id|jobId} or query params
    ?source=&job_id= (body wins). Unknown key -> 404.
    Returns {deleted: {source, job_id}, request_id}.
    """
    source = job_id = None
    if request.is_json:
        data = request.get_json(silent=True)
        if isinstance(data, dict):
            source = data.get("source") or data.get("site")
            job_id = data.get("job_id") or data.get("jobId")
    if not source:
        source = request.args.get("source") or request.args.get("site")
    if not job_id:
        job_id = request.args.get("job_id") or request.args.get("jobId")
    key = _applied_jobs_key(source, job_id)
    if not key[0] or not key[1]:
        return _applied_jobs_error("source and job_id are required.", 400)
    try:
        with _applied_jobs_lock:
            rows = _read_applied_job_rows()
            index = _find_applied_job_index(rows, key[0], key[1])
            if index is None:
                return jsonify({
                    "error": "Not Found",
                    "message": f"No tracked job for source '{key[0]}' job_id '{key[1]}'.",
                    "request_id": getattr(request, "request_id", None),
                }), 404
            del rows[index]
            _write_applied_job_rows(rows)
    except Exception:
        logger.exception("Failed to delete applied job %s", key)
        return jsonify({
            "error": "Internal Server Error",
            "request_id": getattr(request, "request_id", None),
        }), 500
    return jsonify({
        "deleted": {"source": key[0], "job_id": key[1]},
        "request_id": getattr(request, "request_id", None),
    }), 200

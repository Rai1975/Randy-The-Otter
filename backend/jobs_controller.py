import base64
import math
import logging
import os
import random

from flask import Blueprint, request, jsonify

from agents.randy_main import generate_cover_letter_for_job, generate_match_score_for_job, get_randy_agent
from agents.common import sanitize_session_id
from tools.file_channel import bind_file_session, pop_pending_file, reset_file_session
from tools.get_user_profile import _normalize_portfolio, get_autofill_profile

jobs_bp = Blueprint("jobs", __name__)

logger = logging.getLogger(__name__)

from agents.common import MAX_DESCRIPTION_CHARS

# Probability an ambient job sighting (dwell scrape) gets a comment.
# Explicit triggers (click, roast, cover-letter, match-score) always
# comment. Gating happens before the agent call, so misses cost nothing.
# DEMO SETTING — he comments on every posting so the ambient reaction is
# guaranteed on stage. Everyday value: 0.60.
JOB_COMMENT_PROBABILITY = 1.0
# Of the ambient comments that do fire, the share that are a roast instead of
# the usual encouraging quip.
# DEMO SETTING — at 0.20 of 0.60 a roast was ~1 in 8 jobs, so a short demo had
# under a coin-flip chance of showing the feature at all. Everyday value: 0.20.
ROAST_PROBABILITY = 0.70
EXPLICIT_TRIGGERS = {"click", "roast", "cover-letter", "match-score"}

# Backend-driven snarky reply for Roast with no posting on screen.
ROAST_NO_JOB_REPLY = "nothing to roast here — open a job posting first"

AGENT_FALLBACK_REPLY = "oops — brain glitch. try that again?"
NO_DESCRIPTION_REPLY = "no description on this one — can't judge it."

# Menu actions that bypass the random gate and expect a real reply even
# without a job description in other contexts.
ACTION_BYPASS_NO_DESC = {"roast"}
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


def _agent_reply(session_id, description, action=None, preferences=None, portfolio=None):
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
                "answer": "0% match — no description to judge",
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
                return "set your info in settings first — missing personal details", None, None
            missing = [k for k in ("firstName", "lastName", "email", "phoneNumber", "homeAddress") if not isinstance(prefs["personalInformation"].get(k), str) or not prefs["personalInformation"].get(k).strip()]
            if missing:
                logger.warning("cover-letter preferences missing fields: %s", missing)
                return "add your address, phone, and email in settings first", None, None
            raw = generate_cover_letter_for_job(session_id, text, preferences=prefs, portfolio=portfolio).strip()
            return raw or AGENT_FALLBACK_REPLY, None, None
        if action == "match-score":
            ms = generate_match_score_for_job(session_id, text, preferences, portfolio=portfolio)
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
    action = envelope.get("action")
    trigger = envelope.get("trigger")
    preferences = _normalize_preferences(envelope.get("preferences"))
    try:
        portfolio = _normalize_portfolio(envelope.get("portfolio"))
    except Exception:
        portfolio = {"experiences": [], "projects": [], "coursework": []}
    # Canonical explicit action: `action` (new) or legacy `trigger`.
    explicit_action = action or (trigger if trigger in EXPLICIT_TRIGGERS else None)

    short_session = str(session_id)[:8] if session_id else "no-session"

    if event_type == "greeting":
        return f"hey — Randy here (session {short_session}). click me or keep browsing!", True, None, None
    if event_type == "greenhouse-autofill":
        # Acknowledging native-field autofill does not need an agent hop.
        return "filled that out for you — go double check it 🦦", True, None, None
    # Note: job-switch / answer tracking is fully local now
    # (chrome.storage.local randyAppliedJobs). The backend no longer logs
    # applications or generates "did you apply?" prompts.
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
        reply, payload, match_score = _agent_reply(session_id, description, action=ambient_action, preferences=preferences, portfolio=portfolio)
        return reply, True, payload, match_score
    if isinstance(job, dict) and (job.get("title") or job.get("jobId")):
        # Back-compat: legacy callers that POST raw job JSON without envelope.
        if random.random() < JOB_COMMENT_PROBABILITY:
            reply, payload, match_score = _agent_reply(session_id, job.get("description"))
            return reply, True, payload, match_score
        return None, False, None, None
    return f"Randy echo — session {short_session}.", True, None, None


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
        "is_question": False,
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

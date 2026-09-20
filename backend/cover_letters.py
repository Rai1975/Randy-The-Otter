"""Cover-letter delivery blueprint — job_id keyed PDF lifecycle.

Flow:
  POST /cover-letters { session_id, description, preferences, job:{company,title,description} }
    -> 202 { job_id, status:"pending" }
    spawns threading.Thread that calls Strands agent (generate_cover_letter_for_job)
    and captures the PDF via file_channel pop_pending_file(session_id).

  GET /cover-letters/<job_id>/status -> { status:"pending"|"ready"|"error", error? }
  GET /cover-letters/<job_id>.pdf   -> send_file with TTL 15min, deletes on
    first successful GET or after TTL expiry (lazy + threading.Timer).

Keep storage in backend/pdf_out/jobs/{job_id}.pdf (gitignored via **pdf_out).
No auth (uuid4unguessable), no concurrency concerns per spec — simple Lock for dict.

Header fields (FirstName, LastName, Email, Phone, Address) are REQUIRED from
chrome.storage preferences forwarded in the POST body (see content.js
getTailorJobPayload / getTailorPreferences). No env fallback — mirrors
resumes.py but with hard requirement per user request.
"""

import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from agents.common import MAX_DESCRIPTION_CHARS, sanitize_session_id
from agents.randy_main import generate_cover_letter_for_job
from jobs_controller import _normalize_preferences
from tools.file_channel import bind_file_session, pop_pending_file, reset_file_session

logger = logging.getLogger(__name__)

cover_letters_bp = Blueprint("cover_letters", __name__)

TTL_SECONDS = 15 * 60  # 15 min
COVER_LETTER_JOBS_DIR = Path(__file__).resolve().parent / "pdf_out" / "jobs"
# Regex for job_id validation (uuid4 hex + dashes)
_JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

# In-memory store: job_id -> { status, pdf_path|None, filename, created_at, session_id, error, timer }
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _is_valid_job_id(job_id: str) -> bool:
    return isinstance(job_id, str) and bool(_JOB_ID_RE.match(job_id.strip()))


def _is_expired(created_at: float) -> bool:
    return (time.time() - created_at) > TTL_SECONDS


def _expire_job(job_id: str):
    """Timer callback — delete file + pop entry if still pending/ready and TTL passed."""
    with _jobs_lock:
        entry = _jobs.get(job_id)
        if not entry:
            return
        if not _is_expired(entry["created_at"]):
            return
        pdf_path = entry.get("pdf_path")
        _jobs.pop(job_id, None)
    # Delete file outside lock (I/O)
    if pdf_path:
        try:
            if os.path.exists(pdf_path):
                os.remove(pdf_path)
                logger.info("TTL expired: removed %s for job %s", pdf_path, job_id)
        except Exception:
            logger.exception("TTL cleanup failed for job %s", job_id)
    # Also try to remove empty jobs dir quietly
    try:
        if COVER_LETTER_JOBS_DIR.exists() and not any(COVER_LETTER_JOBS_DIR.iterdir()):
            pass
    except Exception:
        pass


def _schedule_expiry(job_id: str):
    """Schedule a one-shot Timer to reap this job after TTL."""
    try:
        t = threading.Timer(TTL_SECONDS + 1, _expire_job, args=[job_id])
        t.daemon = True
        t.start()
        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id]["timer"] = t
    except Exception:
        logger.exception("Failed to schedule expiry for %s", job_id)


def _lazy_expire_if_needed(job_id: str):
    """If job is expired on read, clean up and return True (was expired)."""
    with _jobs_lock:
        entry = _jobs.get(job_id)
        if not entry:
            return False
        if not _is_expired(entry["created_at"]):
            return False
        pdf_path = entry.get("pdf_path")
        _jobs.pop(job_id, None)
    if pdf_path:
        try:
            if os.path.exists(pdf_path):
                os.remove(pdf_path)
        except Exception:
            logger.exception("Lazy TTL delete failed for %s", job_id)
    return True


def _generate(job_id: str, session_id: str, description: str, preferences: dict, company: str | None = None, title: str | None = None):
    """Background thread: run Strands agent and capture PDF to jobs dir.

    preferences is REQUIRED (chrome.storage) — no env fallback. Validated at
    POST time, but re-checked here to fail fast if the thread was somehow
    spawned with bad data.
    """
    try:
        # Bind session so file_channel fallback works if tool_context loses it
        token = bind_file_session(session_id)
        try:
            # This blocks on LLM + pdflatex; it will call generate_cover_letter -> cv_pipeline
            raw = generate_cover_letter_for_job(session_id, description, preferences=preferences, company=company, title=title)
            logger.info("cover-letter agent done for job %s: %s", job_id, (raw or "")[:120])
        finally:
            reset_file_session(token)

        # Capture the PDF the tool produced via file_channel
        pending = None
        try:
            pending = pop_pending_file(session_id=session_id)
        except Exception:
            logger.exception("pop_pending_file failed for job %s", job_id)

        if not pending or not pending.get("path") or not os.path.exists(pending["path"]):
            # Fallback: also try default session (covers edge where agent didn't propagate)
            try:
                fallback = pop_pending_file(session_id="default")
                if fallback and fallback.get("path") and os.path.exists(fallback["path"]):
                    pending = fallback
            except Exception:
                pass

        if not pending or not os.path.exists(pending.get("path", "")):
            logger.warning("No PDF produced for job %s (pending=%s)", job_id, pending)
            with _jobs_lock:
                if job_id in _jobs:
                    _jobs[job_id].update(status="error", error="PDF generation failed — no file produced")
            return

        src_path = pending["path"]
        COVER_LETTER_JOBS_DIR.mkdir(parents=True, exist_ok=True)
        dst_path = str(COVER_LETTER_JOBS_DIR / f"{job_id}.pdf")
        try:
            shutil.copy2(src_path, dst_path)
        except Exception:
            logger.exception("Copy to jobs dir failed for %s", job_id)
            with _jobs_lock:
                if job_id in _jobs:
                    _jobs[job_id].update(status="error", error="Failed to store PDF")
            return

        # Clean up the original company-named PDF in pdf_out (keep jobs copy canonical)
        try:
            if os.path.exists(src_path) and os.path.abspath(src_path) != os.path.abspath(dst_path):
                os.remove(src_path)
        except Exception:
            logger.warning("Failed to remove src PDF %s", src_path)

        # Clean up stray aux files next to src (tex/log/aux/out) if any remain
        try:
            src_base = os.path.splitext(src_path)[0]
            for ext in (".tex", ".aux", ".log", ".out"):
                p = src_base + ext
                if os.path.exists(p):
                    try:
                        os.remove(p)
                    except Exception:
                        pass
        except Exception:
            pass

        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id].update(status="ready", pdf_path=dst_path, filename="cover_letter.pdf")
        logger.info("cover-letter ready: job %s -> %s", job_id, dst_path)

    except Exception as e:
        logger.exception("cover-letter generation failed for job %s", job_id)
        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id].update(status="error", error=str(e)[:500])


def _extract_description(payload: dict) -> str | None:
    """Accept {description} or {job:{description}} or legacy envelope."""
    if not isinstance(payload, dict):
        return None
    # Direct
    if isinstance(payload.get("description"), str) and payload["description"].strip():
        return payload["description"].strip()
    # Nested job.description (scraper shape)
    job = payload.get("job")
    if isinstance(job, dict) and isinstance(job.get("description"), str) and job["description"].strip():
        return job["description"].strip()
    return None


def _extract_job_meta(payload: dict) -> dict:
    """Extract unified job metadata {company, title} from {job:{...}}.

    Accepts `title` or `position` alias for the role. Returns stripped
    strings or None when missing/empty — caller falls back to LLM inference.
    """
    if not isinstance(payload, dict):
        return {"company": None, "title": None}
    job = payload.get("job")
    if not isinstance(job, dict):
        return {"company": None, "title": None}

    def _clean(value) -> str | None:
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value or None

    company = _clean(job.get("company"))
    title = _clean(job.get("title")) or _clean(job.get("position"))
    return {"company": company, "title": title}


@cover_letters_bp.route("/cover-letters", methods=["POST"])
def create_cover_letter():
    if not request.is_json:
        return jsonify({"error": "Bad Request", "message": "Request body must be JSON", "request_id": getattr(request, "request_id", None)}), 400

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Bad Request", "message": "Malformed JSON body", "request_id": getattr(request, "request_id", None)}), 400

    session_id = sanitize_session_id(data.get("session_id"))
    description = _extract_description(data)
    meta = _extract_job_meta(data)
    company, title = meta["company"], meta["title"]

    # Preferences are REQUIRED — chrome.storage only, no env fallback
    raw_prefs = data.get("preferences")
    if not isinstance(raw_prefs, dict):
        return jsonify({"error": "Bad Request", "message": "Missing 'preferences' — cover letter requires chrome.storage preferences (personalInformation.firstName/lastName/email/phoneNumber/homeAddress)", "request_id": getattr(request, "request_id", None)}), 400
    try:
        preferences = _normalize_preferences(raw_prefs)
    except Exception:
        return jsonify({"error": "Bad Request", "message": "Invalid 'preferences' shape", "request_id": getattr(request, "request_id", None)}), 400

    # Validate required personal fields after normalization (empty strings mean missing)
    personal = preferences.get("personalInformation") if isinstance(preferences, dict) else None
    if not isinstance(personal, dict):
        return jsonify({"error": "Bad Request", "message": "Missing personalInformation in preferences", "request_id": getattr(request, "request_id", None)}), 400
    missing = [k for k in ("firstName", "lastName", "email", "phoneNumber", "homeAddress") if not isinstance(personal.get(k), str) or not personal.get(k).strip()]
    if missing:
        return jsonify({"error": "Bad Request", "message": f"Missing required preferences.personalInformation fields: {', '.join(missing)} — cover letter requires chrome.storage", "request_id": getattr(request, "request_id", None)}), 400

    if not description:
        return jsonify({"error": "Bad Request", "message": "Missing 'description' (or job.description) — cannot generate cover letter", "request_id": getattr(request, "request_id", None)}), 400

    if len(description) > MAX_DESCRIPTION_CHARS + 500:
        # Truncate server-side rather than reject — matches jobs_controller behaviour
        description = description[: MAX_DESCRIPTION_CHARS + 500]

    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "pending",
            "pdf_path": None,
            "filename": "cover_letter.pdf",
            "created_at": time.time(),
            "session_id": session_id,
            "company": company,
            "title": title,
            "error": None,
            "timer": None,
        }

    _schedule_expiry(job_id)

    # Fire-and-forget generation — preferences are required
    t = threading.Thread(target=_generate, args=(job_id, session_id, description, preferences, company, title), daemon=True)
    t.start()

    return jsonify({"job_id": job_id, "status": "pending", "request_id": getattr(request, "request_id", None)}), 202


@cover_letters_bp.route("/cover-letters/<job_id>/status", methods=["GET"])
def cover_letter_status(job_id):
    if not _is_valid_job_id(job_id):
        return jsonify({"error": "Not Found", "message": "Invalid job_id", "request_id": getattr(request, "request_id", None)}), 404

    if _lazy_expire_if_needed(job_id):
        return jsonify({"error": "Not Found", "message": "Job expired", "status": "expired", "request_id": getattr(request, "request_id", None)}), 404

    with _jobs_lock:
        entry = _jobs.get(job_id)
        if not entry:
            return jsonify({"error": "Not Found", "message": "Job not found", "request_id": getattr(request, "request_id", None)}), 404
        # Copy for response
        status = entry["status"]
        error = entry.get("error")

    body = {"job_id": job_id, "status": status, "request_id": getattr(request, "request_id", None)}
    if error:
        body["error"] = error
    return jsonify(body), 200


@cover_letters_bp.route("/cover-letters/<job_id>.pdf", methods=["GET"])
def cover_letter_pdf(job_id):
    if not _is_valid_job_id(job_id):
        return jsonify({"error": "Not Found", "message": "Invalid job_id", "request_id": getattr(request, "request_id", None)}), 404

    if _lazy_expire_if_needed(job_id):
        return jsonify({"error": "Not Found", "message": "Job expired", "status": "expired", "request_id": getattr(request, "request_id", None)}), 404

    with _jobs_lock:
        entry = _jobs.get(job_id)
        if not entry:
            return jsonify({"error": "Not Found", "message": "Job not found", "request_id": getattr(request, "request_id", None)}), 404
        if entry["status"] == "pending":
            return jsonify({"error": "Too Early", "message": "PDF not ready yet", "status": "pending", "request_id": getattr(request, "request_id", None)}), 425
        if entry["status"] == "error":
            return jsonify({"error": "Generation Failed", "message": entry.get("error") or "Unknown", "status": "error", "request_id": getattr(request, "request_id", None)}), 500
        pdf_path = entry.get("pdf_path")

    if not pdf_path or not os.path.exists(pdf_path):
        logger.warning("PDF missing on disk for job %s: %s", job_id, pdf_path)
        with _jobs_lock:
            _jobs.pop(job_id, None)
        return jsonify({"error": "Not Found", "message": "PDF not found on server", "request_id": getattr(request, "request_id", None)}), 404

    # Serve the file; delete on successful send (cleanup after first successful GET).
    # We pop the entry before sending so re-entry after TTL doesn't re-serve.
    # But we keep pdf_path for send_file and delete after response.
    # Use after_this_request hook would be cleaner, but simple: send then delete in
    # a way that doesn't race the file read — Flask reads file before we delete
    # if we delete in a callback. Use a wrapper: pop now, schedule delete after send.

    # Pop eagerly so second GET won't re-serve
    with _jobs_lock:
        # Cancel timer
        timer = _jobs.get(job_id, {}).get("timer")
        if timer:
            try:
                timer.cancel()
            except Exception:
                pass
        _jobs.pop(job_id, None)

    # Schedule file delete shortly after response is done (give Flask time to read)
    def _delete_after():
        # Small delay to let send_file finish reading
        time.sleep(0.5)
        try:
            if os.path.exists(pdf_path):
                os.remove(pdf_path)
                logger.info("Cleaned up PDF after download: %s", pdf_path)
        except Exception:
            logger.exception("Cleanup after download failed for %s", job_id)
        # Remove empty jobs dir shell
        try:
            if COVER_LETTER_JOBS_DIR.exists() and not any(COVER_LETTER_JOBS_DIR.iterdir()):
                COVER_LETTER_JOBS_DIR.rmdir()
        except Exception:
            pass

    threading.Thread(target=_delete_after, daemon=True).start()

    return send_file(
        pdf_path,
        mimetype="application/pdf",
        as_attachment=True,
        download_name="cover_letter.pdf",
        max_age=0,
        conditional=False,
    )

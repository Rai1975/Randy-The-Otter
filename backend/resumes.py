"""Resume delivery blueprint — mirrors cover_letters.py but for tailored resumes.

Flow:
  POST /resumes { session_id, description, preferences, job:{company,title,description} }
    -> 202 { job_id, status:"pending" }
    spawns threading.Thread that calls Strands agent (generate_resume_for_job)
    and captures the PDF via file_channel pop_pending_file(session_id).

  GET /resumes/<job_id>/status -> { status:"pending"|"ready"|"error", error? }
  GET /resumes/<job_id>.pdf   -> send_file with TTL 15min, deletes on first GET or TTL.

Keep storage in backend/pdf_out/jobs/{job_id}.pdf (shared dir, cover letters and
resumes both use .pdf with same TTL). No auth, uuid4.

Header fields (FullName, Email, URLs) are sourced from chrome.storage
preferences forwarded in the POST body (see content.js getTailorJobPayload).
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
from agents.randy_main import generate_resume_for_job
from jobs_controller import _normalize_preferences
from tools.file_channel import bind_file_session, pop_pending_file, reset_file_session

logger = logging.getLogger(__name__)

resumes_bp = Blueprint("resumes", __name__)

TTL_SECONDS = 15 * 150
RESUME_JOBS_DIR = Path(__file__).resolve().parent / "pdf_out" / "jobs"
_JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _is_valid_job_id(job_id: str) -> bool:
    return isinstance(job_id, str) and bool(_JOB_ID_RE.match(job_id.strip()))


def _is_expired(created_at: float) -> bool:
    return (time.time() - created_at) > TTL_SECONDS


def _expire_job(job_id: str):
    with _jobs_lock:
        entry = _jobs.get(job_id)
        if not entry:
            return
        if not _is_expired(entry["created_at"]):
            return
        pdf_path = entry.get("pdf_path")
        _jobs.pop(job_id, None)
    if pdf_path:
        try:
            if os.path.exists(pdf_path):
                os.remove(pdf_path)
                logger.info("TTL expired: removed %s for resume job %s", pdf_path, job_id)
        except Exception:
            logger.exception("TTL cleanup failed for resume job %s", job_id)
    try:
        if RESUME_JOBS_DIR.exists() and not any(RESUME_JOBS_DIR.iterdir()):
            pass
    except Exception:
        pass


def _schedule_expiry(job_id: str):
    try:
        t = threading.Timer(TTL_SECONDS + 1, _expire_job, args=[job_id])
        t.daemon = True
        t.start()
        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id]["timer"] = t
    except Exception:
        logger.exception("Failed to schedule expiry for resume %s", job_id)


def _lazy_expire_if_needed(job_id: str):
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
            logger.exception("Lazy TTL delete failed for resume %s", job_id)
    return True


def _generate(job_id: str, session_id: str, description: str, preferences=None, company: str | None = None, title: str | None = None):
    """Background thread: run resume agent and capture PDF."""
    try:
        token = bind_file_session(session_id)
        try:
            raw = generate_resume_for_job(session_id, description, preferences=preferences, company=company, title=title)
            logger.info("resume agent done for job %s: %s", job_id, (raw or "")[:120])
        finally:
            reset_file_session(token)

        pending = None
        try:
            pending = pop_pending_file(session_id=session_id)
        except Exception:
            logger.exception("pop_pending_file failed for resume job %s", job_id)

        if not pending or not pending.get("path") or not os.path.exists(pending["path"]):
            try:
                fallback = pop_pending_file(session_id="default")
                if fallback and fallback.get("path") and os.path.exists(fallback["path"]):
                    pending = fallback
            except Exception:
                pass

        if not pending or not os.path.exists(pending.get("path", "")):
            logger.warning("No PDF produced for resume job %s (pending=%s)", job_id, pending)
            with _jobs_lock:
                if job_id in _jobs:
                    _jobs[job_id].update(status="error", error="PDF generation failed — no file produced")
            return

        src_path = pending["path"]
        RESUME_JOBS_DIR.mkdir(parents=True, exist_ok=True)
        dst_path = str(RESUME_JOBS_DIR / f"{job_id}.pdf")
        try:
            shutil.copy2(src_path, dst_path)
        except Exception:
            logger.exception("Copy to jobs dir failed for resume %s", job_id)
            with _jobs_lock:
                if job_id in _jobs:
                    _jobs[job_id].update(status="error", error="Failed to store PDF")
            return

        try:
            if os.path.exists(src_path) and os.path.abspath(src_path) != os.path.abspath(dst_path):
                os.remove(src_path)
        except Exception:
            logger.warning("Failed to remove src PDF %s", src_path)

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
                _jobs[job_id].update(status="ready", pdf_path=dst_path, filename="resume.pdf")
        logger.info("resume ready: job %s -> %s", job_id, dst_path)

    except Exception as e:
        logger.exception("resume generation failed for job %s", job_id)
        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id].update(status="error", error=str(e)[:500])


def _extract_description(payload: dict) -> str | None:
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("description"), str) and payload["description"].strip():
        return payload["description"].strip()
    job = payload.get("job")
    if isinstance(job, dict) and isinstance(job.get("description"), str) and job["description"].strip():
        return job["description"].strip()
    return None


def _extract_job_meta(payload: dict) -> dict:
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


@resumes_bp.route("/resumes", methods=["POST"])
def create_resume():
    if not request.is_json:
        return jsonify({"error": "Bad Request", "message": "Request body must be JSON", "request_id": getattr(request, "request_id", None)}), 400

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Bad Request", "message": "Malformed JSON body", "request_id": getattr(request, "request_id", None)}), 400

    session_id = sanitize_session_id(data.get("session_id"))
    description = _extract_description(data)
    meta = _extract_job_meta(data)
    company, title = meta["company"], meta["title"]

    # Preferences are optional but forwarded to the resume agent for header fill
    raw_prefs = data.get("preferences")
    preferences = None
    if isinstance(raw_prefs, dict):
        try:
            preferences = _normalize_preferences(raw_prefs)
        except Exception:
            preferences = raw_prefs

    if not description:
        return jsonify({"error": "Bad Request", "message": "Missing 'description' (or job.description) — cannot generate resume", "request_id": getattr(request, "request_id", None)}), 400

    if len(description) > MAX_DESCRIPTION_CHARS + 500:
        description = description[: MAX_DESCRIPTION_CHARS + 500]

    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "pending",
            "pdf_path": None,
            "filename": "resume.pdf",
            "created_at": time.time(),
            "session_id": session_id,
            "company": company,
            "title": title,
            "error": None,
            "timer": None,
        }

    _schedule_expiry(job_id)

    t = threading.Thread(target=_generate, args=(job_id, session_id, description, preferences, company, title), daemon=True)
    t.start()

    return jsonify({"job_id": job_id, "status": "pending", "request_id": getattr(request, "request_id", None)}), 202


@resumes_bp.route("/resumes/<job_id>/status", methods=["GET"])
def resume_status(job_id):
    if not _is_valid_job_id(job_id):
        return jsonify({"error": "Not Found", "message": "Invalid job_id", "request_id": getattr(request, "request_id", None)}), 404

    if _lazy_expire_if_needed(job_id):
        return jsonify({"error": "Not Found", "message": "Job expired", "status": "expired", "request_id": getattr(request, "request_id", None)}), 404

    with _jobs_lock:
        entry = _jobs.get(job_id)
        if not entry:
            return jsonify({"error": "Not Found", "message": "Job not found", "request_id": getattr(request, "request_id", None)}), 404
        status = entry["status"]
        error = entry.get("error")

    body = {"job_id": job_id, "status": status, "request_id": getattr(request, "request_id", None)}
    if error:
        body["error"] = error
    return jsonify(body), 200


@resumes_bp.route("/resumes/<job_id>.pdf", methods=["GET"])
def resume_pdf(job_id):
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
        logger.warning("PDF missing on disk for resume job %s: %s", job_id, pdf_path)
        with _jobs_lock:
            _jobs.pop(job_id, None)
        return jsonify({"error": "Not Found", "message": "PDF not found on server", "request_id": getattr(request, "request_id", None)}), 404

    with _jobs_lock:
        timer = _jobs.get(job_id, {}).get("timer")
        if timer:
            try:
                timer.cancel()
            except Exception:
                pass
        _jobs.pop(job_id, None)

    def _delete_after():
        time.sleep(0.5)
        try:
            if os.path.exists(pdf_path):
                os.remove(pdf_path)
                logger.info("Cleaned up PDF after download: %s", pdf_path)
        except Exception:
            logger.exception("Cleanup after download failed for resume %s", job_id)
        try:
            if RESUME_JOBS_DIR.exists() and not any(RESUME_JOBS_DIR.iterdir()):
                RESUME_JOBS_DIR.rmdir()
        except Exception:
            pass

    threading.Thread(target=_delete_after, daemon=True).start()

    return send_file(
        pdf_path,
        mimetype="application/pdf",
        as_attachment=True,
        download_name="resume.pdf",
        max_age=0,
        conditional=False,
    )

"""Portfolio blueprint — experiences / projects / coursework.

Defaults live in backend/data/*.json (committed). User overrides are persisted
to separate files (user_experiences.json etc.) so defaults are never mutated;
GET prefers user file if present else defaults. PUT validates and atomically
writes the user file.

Routes:
  GET /portfolio                     -> all three collections
  GET /portfolio/experiences         -> {experiences, count}
  GET /portfolio/projects            -> {projects, count}
  GET /portfolio/coursework          -> {coursework, count}
  PUT /portfolio/experiences         -> {experiences, count}
  PUT /portfolio/projects            -> {projects, count}
  PUT /portfolio/coursework          -> {coursework, count}
"""

import json
import os
import threading
from pathlib import Path

from flask import Blueprint, jsonify, request

portfolio_bp = Blueprint("portfolio", __name__)

DATA_DIR = Path(__file__).resolve().parent / "data"

# Separate user files so defaults stay pristine.
USER_FILES = {
    "experiences": DATA_DIR / "user_experiences.json",
    "projects": DATA_DIR / "user_projects.json",
    "coursework": DATA_DIR / "user_coursework.json",
}
DEFAULT_FILES = {
    "experiences": DATA_DIR / "experiences.json",
    "projects": DATA_DIR / "projects.json",
    "coursework": DATA_DIR / "coursework.json",
}

_portfolio_lock = threading.Lock()

# Caps - generous, guards pathological payloads.
MAX_TEXT = 5000
MAX_ITEMS = 100
MAX_BODY_BYTES = 2 * 1024 * 1024


def _data_path(filename):
    return str(DATA_DIR / filename)


def _load_json_file(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path.name} root must be a list")
    return data


def _effective_data(kind: str):
    """Return user data if present else defaults. Never creates files."""
    user_path = USER_FILES[kind]
    default_path = DEFAULT_FILES[kind]
    # user file wins if it exists and is valid
    if user_path.exists() and user_path.stat().st_size > 0:
        try:
            return _load_json_file(user_path)
        except Exception:
            # corrupted user file -> fall back to defaults
            pass
    return _load_json_file(default_path)


def _clean_text(value, cap=MAX_TEXT):
    if not isinstance(value, str):
        return ""
    # single-line-ish for title/org/date/etc but description keeps newlines
    text = value.strip()
    if len(text) > cap:
        text = text[:cap].rstrip()
    return text


def _normalize_experience(item):
    if not isinstance(item, dict):
        return None
    title = _clean_text(item.get("title"), 300)
    if not title:
        return None  # title required
    # logo/screenshot intentionally ignored per spec (forget about pictures)
    return {
        "title": title,
        "organization": _clean_text(item.get("organization"), 300),
        "date": _clean_text(item.get("date"), 200),
        "link": _clean_text(item.get("link"), 500),
        "description": _clean_text(item.get("description"), MAX_TEXT),
        # preserve logo/link if caller sent them, but UI won't; we drop logo
    }


def _normalize_project(item):
    if not isinstance(item, dict):
        return None
    title = _clean_text(item.get("title"), 300)
    if not title:
        return None
    return {
        "title": title,
        "link": _clean_text(item.get("link"), 500),
        "stack": _clean_text(item.get("stack"), 500),
        "category": _clean_text(item.get("category"), 200),
        "description": _clean_text(item.get("description"), MAX_TEXT),
    }


def _normalize_coursework(item):
    if not isinstance(item, dict):
        return None
    title = _clean_text(item.get("title"), 300)
    if not title:
        return None
    return {
        "title": title,
        "link": _clean_text(item.get("link"), 500),
        "stack": _clean_text(item.get("stack"), 500),
        "category": _clean_text(item.get("category"), 200),
        "description": _clean_text(item.get("description"), MAX_TEXT),
    }


NORMALIZERS = {
    "experiences": _normalize_experience,
    "projects": _normalize_project,
    "coursework": _normalize_coursework,
}


def _atomic_write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def _handle_get(kind: str):
    try:
        items = _effective_data(kind)
    except FileNotFoundError as e:
        return jsonify({"error": "Not Found", "message": str(e), "request_id": getattr(request, "request_id", None)}), 500
    except Exception as e:
        return jsonify({"error": "Internal Server Error", "message": str(e)[:300], "request_id": getattr(request, "request_id", None)}), 500
    key = kind
    return jsonify({key: items, "count": len(items), "request_id": getattr(request, "request_id", None)}), 200


def _handle_put(kind: str):
    if request.content_length and request.content_length > MAX_BODY_BYTES:
        return jsonify({"error": "Bad Request", "message": "Payload too large", "request_id": getattr(request, "request_id", None)}), 400
    if not request.is_json:
        return jsonify({"error": "Bad Request", "message": "Request body must be JSON", "request_id": getattr(request, "request_id", None)}), 400
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Bad Request", "message": "Malformed JSON body", "request_id": getattr(request, "request_id", None)}), 400

    # Accept either {experiences: [...]} or raw [...]
    raw_items = None
    if isinstance(data, list):
        raw_items = data
    elif isinstance(data, dict):
        # allow {experiences: [...]}, {projects: [...]}, {coursework: [...]}, or {items: [...]} or {data: [...]}
        for key in (kind, "items", "data"):
            if isinstance(data.get(key), list):
                raw_items = data[key]
                break
        if raw_items is None and kind in data:
            # kind key exists but not a list -> error
            return jsonify({"error": "Bad Request", "message": f"'{kind}' must be a list", "request_id": getattr(request, "request_id", None)}), 400
        if raw_items is None:
            # single object wrapped? treat dict with title as one item
            if isinstance(data.get("title"), str):
                raw_items = [data]
            else:
                return jsonify({"error": "Bad Request", "message": f"Missing '{kind}' list (or send raw JSON array)", "request_id": getattr(request, "request_id", None)}), 400
    else:
        return jsonify({"error": "Bad Request", "message": "Body must be JSON array or object", "request_id": getattr(request, "request_id", None)}), 400

    if len(raw_items) > MAX_ITEMS:
        return jsonify({"error": "Bad Request", "message": f"Too many items (max {MAX_ITEMS})", "request_id": getattr(request, "request_id", None)}), 400

    normalizer = NORMALIZERS[kind]
    normalized = []
    errors = []
    for idx, item in enumerate(raw_items):
        n = normalizer(item)
        if n is None:
            # only hard error is missing title; skip with error
            if isinstance(item, dict) and not _clean_text(item.get("title"), 300):
                errors.append(f"item {idx}: 'title' is required")
            else:
                errors.append(f"item {idx}: invalid")
            continue
        normalized.append(n)

    if errors:
        return jsonify({"error": "Bad Request", "message": "; ".join(errors[:5]), "request_id": getattr(request, "request_id", None)}), 400

    try:
        with _portfolio_lock:
            _atomic_write_json(USER_FILES[kind], normalized)
    except Exception as e:
        return jsonify({"error": "Internal Server Error", "message": str(e)[:300], "request_id": getattr(request, "request_id", None)}), 500

    return jsonify({kind: normalized, "count": len(normalized), "request_id": getattr(request, "request_id", None)}), 200


@portfolio_bp.route("/portfolio", methods=["GET"])
def get_all_portfolio():
    try:
        experiences = _effective_data("experiences")
        projects = _effective_data("projects")
        coursework = _effective_data("coursework")
    except Exception as e:
        return jsonify({"error": "Internal Server Error", "message": str(e)[:300], "request_id": getattr(request, "request_id", None)}), 500
    return jsonify({
        "experiences": experiences,
        "projects": projects,
        "coursework": coursework,
        "request_id": getattr(request, "request_id", None),
    }), 200


@portfolio_bp.route("/portfolio/experiences", methods=["GET"])
def get_experiences():
    return _handle_get("experiences")


@portfolio_bp.route("/portfolio/projects", methods=["GET"])
def get_projects():
    return _handle_get("projects")


@portfolio_bp.route("/portfolio/coursework", methods=["GET"])
def get_coursework():
    return _handle_get("coursework")


@portfolio_bp.route("/portfolio/experiences", methods=["PUT"])
def put_experiences():
    return _handle_put("experiences")


@portfolio_bp.route("/portfolio/projects", methods=["PUT"])
def put_projects():
    return _handle_put("projects")


@portfolio_bp.route("/portfolio/coursework", methods=["PUT"])
def put_coursework():
    return _handle_put("coursework")

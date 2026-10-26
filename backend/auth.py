"""Session-token auth for the Randy API — no login, 1h signed tokens.

Flow:
  POST /auth/session -> 200 { token, token_type:"Bearer", expires_in:3600 }
    mints a token signed with AUTH_TOKEN_SECRET (itsdangerous, already a
    Flask dependency). The token carries a random session id and its issue
    time; nothing is stored server-side, so tokens survive across workers
    that share the secret and the backend still stores no user data.

  Every other route (except /health and CORS preflight) requires
    Authorization: Bearer <token>
  and gets 401 when it is missing, malformed, tampered with or older than
  TOKEN_TTL_SECONDS. The extension mints a fresh token and retries once.

  Only the extension's service worker talks to this API, so the token and
  this endpoint never appear in the job site's DevTools. Tokens are never
  accepted from the query string: PDF downloads send the header through
  chrome.downloads' `headers` option, and a URL token would leak into
  chrome://downloads and access logs.

This is a gate against casual/scripted use of the API, not identity: anyone
who can reach /auth/session can mint a token. It caps a leaked token at 1h.

If AUTH_TOKEN_SECRET is unset the server signs with a random per-process
secret. That works for local dev, but every restart invalidates outstanding
tokens and multiple replicas would reject each other's tokens.
"""

import logging
import os
import secrets

from dotenv import load_dotenv
from flask import Blueprint, g, jsonify, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

load_dotenv()

logger = logging.getLogger(__name__)

TOKEN_TTL_SECONDS = 3600
_TOKEN_SALT = "randy-session-token"

# Endpoints reachable without a token: liveness and the token mint itself.
_PUBLIC_ENDPOINTS = {"health", "auth.create_session", "static"}

auth_bp = Blueprint("auth", __name__)


def _load_secret() -> str:
    secret = os.getenv("AUTH_TOKEN_SECRET", "").strip()
    if secret:
        return secret
    logger.warning(
        "AUTH_TOKEN_SECRET is not set; using a random per-process secret. "
        "Tokens will be invalidated on every restart."
    )
    return secrets.token_urlsafe(48)


_serializer = URLSafeTimedSerializer(_load_secret(), salt=_TOKEN_SALT)


def issue_token() -> str:
    return _serializer.dumps({"sid": secrets.token_urlsafe(16)})


def verify_token(token: str) -> dict:
    """Return the token payload. Raises SignatureExpired / BadSignature."""
    payload = _serializer.loads(token, max_age=TOKEN_TTL_SECONDS)
    if not isinstance(payload, dict) or not isinstance(payload.get("sid"), str):
        raise BadSignature("Malformed token payload")
    return payload


def _extract_token() -> str | None:
    header = request.headers.get("Authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() == "bearer" and value.strip():
        return value.strip()
    return None


def _unauthorized(message: str):
    return jsonify({
        "error": "Unauthorized",
        "message": message,
        "request_id": getattr(request, "request_id", None),
    }), 401


def require_session_token():
    # Preflight carries no Authorization header; flask-cors answers it.
    if request.method == "OPTIONS":
        return None
    # endpoint is None for unknown paths: let the normal 404 handler respond.
    if request.endpoint is None or request.endpoint in _PUBLIC_ENDPOINTS:
        return None

    token = _extract_token()
    if not token:
        return _unauthorized("Missing session token")
    try:
        g.auth_session = verify_token(token)
    except SignatureExpired:
        return _unauthorized("Session token expired")
    except BadSignature:
        return _unauthorized("Invalid session token")
    return None


@auth_bp.route("/auth/session", methods=["POST"])
def create_session():
    return jsonify({
        "token": issue_token(),
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL_SECONDS,
    }), 200


def init_auth(app):
    """Register the token endpoint and the guard on every other route."""
    app.register_blueprint(auth_bp)
    app.before_request(require_session_token)

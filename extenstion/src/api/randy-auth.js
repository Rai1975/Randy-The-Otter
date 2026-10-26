/* Randy auth — short-lived session token for every backend call.
 *
 * Service worker only (importScripts in background.js). Content scripts
 * must not load it: their requests show in the job site's DevTools Network
 * tab, which would hand anyone the token. The token lives in SW memory,
 * minted once per wake-up. No login — POST /auth/session mints a signed
 * token the backend accepts for 1h.
 *
 * randyAuthFetch() attaches `Authorization: Bearer <token>`, refreshes a
 * minute before expiry, and on a 401 (expired, or the server restarted with
 * a new secret) mints a fresh token and retries once.
 */

const RANDY_AUTH_ORIGIN = (typeof BACKEND_URL !== "undefined" && BACKEND_URL ? BACKEND_URL : "http://127.0.0.1:5000").replace(/\/+$/, "");
// Refresh early so a request never leaves with a token that expires in flight.
const RANDY_AUTH_REFRESH_MARGIN_MS = 60 * 1000;

let randyAuthToken = null;
let randyAuthExpiresAt = 0;
// Shared in-flight mint so concurrent callers don't each request a token.
let randyAuthPending = null;

/**
 * Return a valid session token, minting one when missing or near expiry.
 * @param {boolean} [forceRefresh] - discard the cached token (after a 401)
 * @returns {Promise<string>}
 */
async function getRandyAuthToken(forceRefresh) {
  if (forceRefresh) {
    randyAuthToken = null;
  } else if (randyAuthToken && Date.now() < randyAuthExpiresAt - RANDY_AUTH_REFRESH_MARGIN_MS) {
    return randyAuthToken;
  }
  if (!randyAuthPending) {
    randyAuthPending = (async () => {
      const resp = await fetch(`${RANDY_AUTH_ORIGIN}/auth/session`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const body = await resp.json().catch(() => null);
      if (!resp.ok || !body || typeof body.token !== "string") {
        throw new Error(body?.message || `auth/session responded ${resp.status}`);
      }
      const ttlSeconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
      randyAuthToken = body.token;
      randyAuthExpiresAt = Date.now() + ttlSeconds * 1000;
      return randyAuthToken;
    })().finally(() => {
      randyAuthPending = null;
    });
  }
  return randyAuthPending;
}

/**
 * fetch() with the session token attached; retries once on 401.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function randyAuthFetch(url, options) {
  const opts = options || {};
  const send = (token) =>
    fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  const response = await send(await getRandyAuthToken(false));
  if (response.status !== 401) return response;
  return send(await getRandyAuthToken(true));
}


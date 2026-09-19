/* Randy session — per-page-load unique session ID.
 *
 * Loaded FIRST in manifest.json content_scripts (before randy-backend.js).
 * One UUID per content-script instance: generated on first use, reused for
 * every backend call until the page refreshes. Survives LinkedIn SPA
 * navigations (no reload) so Randy "holds" the session without a refresh.
 * No chrome.storage — persistence across reloads is explicitly out of scope.
 * The future AWS Strands side will use this ID for conversation memory;
 * for now the backend only echoes it.
 */

const RANDY_SESSION_KEY = "__randySessionId";

/**
 * Generate a UUID v4. Prefers crypto.randomUUID, falls back to
 * crypto.getRandomValues, then Math.random (never throws).
 * @returns {string}
 */
function generateRandySessionId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      return (
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
        `${hex.slice(16, 20)}-${hex.slice(20)}`
      );
    }
  } catch {
    // Fall through to Math.random fallback.
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get (creating on first call) this page-load's Randy session ID.
 * @returns {string} stable UUID for the life of this content-script instance
 */
function getRandySessionId() {
  if (typeof window !== "undefined" && window[RANDY_SESSION_KEY]) {
    return window[RANDY_SESSION_KEY];
  }
  const id = generateRandySessionId();
  if (typeof window !== "undefined") {
    window[RANDY_SESSION_KEY] = id;
  }
  return id;
}

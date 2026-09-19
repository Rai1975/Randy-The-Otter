/* Randy backend client — session-aware POST helpers.
 *
 * Load order in manifest.json content_scripts:
 *   1. randy-session.js  (getRandySessionId)
 *   2. this file         (sendRandyJob / sendRandyEvent)
 * Site scrapers (linkedin/handshake) call sendRandyJob(); content.js calls
 * sendRandyEvent() for greeting/click/answer. Fire-and-forget: never throws,
 * so scrape/UI flow is unaffected when the backend is down.
 *
 * Envelope sent on every call:
 *   { session_id: string, type: string, job?: object|null, answer?: string,
 *     action?: "roast" | "cover-letter" | "match-score",
 *     trigger?: "click" | "roast" }
 * The backend echoes session_id back plus a `reply` string — ALL bubble
 * text must come from that `reply`, never from hardcoded strings — and a
 * `show` flag telling the bubble whether to appear at all plus `payload`
 * (LaTeX for cover-letter). Ambient job sightings are randomly gated;
 * explicit actions/triggers always comment.
 */

const RANDY_JOB_SUMMARY_URL = "http://127.0.0.1:5000/job-summary";

// Send-order sequencing: every outgoing envelope gets a monotonic seq tag
// (assigned at send time) stamped onto its parsed response as __randySeq.
// setBubbleFromBackend() (bubble.js) renders only the newest response and
// drops stale arrivals, so a slow earlier request (e.g. greeting, or a job
// scrape with a long DOM wait) can never overwrite a newer message.
let randyEnvelopeSeq = 0;

/**
 * POST an envelope to the Randy backend.
 * @param {object} payload - envelope fields (type, job, answer, ...)
 * @returns {Promise<object|null>} backend response (tagged with __randySeq)
 *   or null on failure
 */
async function postRandyEnvelope(payload) {
  const sessionId =
    typeof getRandySessionId === "function" ? getRandySessionId() : null;
  const envelope = { session_id: sessionId, ...(payload || {}) };
  const seq = ++randyEnvelopeSeq;
  try {
    const response = await fetch(RANDY_JOB_SUMMARY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) {
      console.warn(`[Randy] Backend responded ${response.status}`);
      return null;
    }
    const data = await response.json().catch(() => null);
    if (data && typeof data === "object") {
      data.__randySeq = seq;
    }
    console.log("[Randy] Backend echo:", data);
    return data;
  } catch (error) {
    console.warn("[Randy] Backend POST failed (is server.py running?):", error);
    return null;
  }
}

/**
 * POST a scraped job with this page-load's session ID.
 * @param {object} job - scraped job JSON (null allowed for trigger: roast
 *   with no posting on screen — the backend replies with a snarky line)
 * @param {object} [extra] - extra envelope fields (e.g. { trigger: "roast" }
 *   so an explicit action always gets a comment, bypassing the random gate)
 * @returns {Promise<object|null>} backend response or null on failure
 */
async function sendRandyJob(job, extra) {
  if (!job) {
    return null;
  }
  return postRandyEnvelope({ type: "job", job, ...(extra || {}) });
}

/**
 * POST a UI event (greeting/click/answer) with this session ID.
 * @param {string} type - "greeting" | "click" | "answer" | string
 * @param {object} [extra] - extra envelope fields (e.g. { answer: "yes" })
 * @returns {Promise<object|null>} backend response or null on failure
 */
async function sendRandyEvent(type, extra) {
  return postRandyEnvelope({ type, ...(extra || {}) });
}

/**
 * Extract the backend-driven bubble text from a backend response.
 * @param {object|null} data - backend JSON
 * @returns {string|null} reply text or null when absent
 */
function getRandyReply(data) {
  if (data && typeof data.reply === "string" && data.reply.trim()) {
    return data.reply;
  }
  return null;
}

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
 *     trigger?: "click" | "roast",
 *     previous_job?: { source, job_id, title, company },
 *     about_job?: { source, job_id, title, company } }
 * The backend echoes session_id back plus a `reply` string — ALL bubble
 * text must come from that `reply`, never from hardcoded strings — and a
 * `show` flag telling the bubble whether to appear at all plus `payload`
 * (LaTeX for cover-letter) and `is_question` for Yes/No. Job-switch asks
 * "Did you apply?" (Yes writes to data/applied_jobs.csv).
 */

const RANDY_JOB_SUMMARY_URL = `${(typeof BACKEND_URL !== "undefined" && BACKEND_URL ? BACKEND_URL : "http://127.0.0.1:5000").replace(/\/+$/, "")}/job-summary`;
const RANDY_PREFERENCES_KEY = "randyPreferences";

// Send-order sequencing: every outgoing envelope gets a monotonic seq tag
// (assigned at send time) stamped onto its parsed response as __randySeq.
// setBubbleFromBackend() (bubble.js) renders only the newest response and
// drops stale arrivals, so a slow earlier request (e.g. greeting, or a job
// scrape with a long DOM wait) can never overwrite a newer message.
let randyEnvelopeSeq = 0;

async function getRandyPreferences() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    return null;
  }
  try {
    const result = await chrome.storage.local.get(RANDY_PREFERENCES_KEY);
    return result[RANDY_PREFERENCES_KEY] || null;
  } catch (error) {
    console.warn("[Randy] Preferences unavailable:", error);
    return null;
  }
}

/**
 * Try background fetch first (privileged, bypasses CORS/CSP), fallback to direct.
 * @param {object} envelope
 * @param {number} seq
 * @returns {Promise<object|null>}
 */
async function postViaBackgroundOrDirect(envelope, seq) {
  // Background path — chrome.runtime available and not orphaned
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
    try {
      const bgResult = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "randy-job-summary", envelope }, (resp) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(resp || null);
          });
        } catch (_) {
          resolve(null);
        }
      });
      if (bgResult && bgResult.ok && bgResult.data && typeof bgResult.data === "object") {
        const data = bgResult.data;
        data.__randySeq = seq;
        console.log("[Randy] Backend echo (via BG):", data);
        return data;
      }
      if (bgResult && bgResult.ok === false) {
        console.warn("[Randy] BG job-summary failed, falling back to direct:", bgResult.error);
      }
    } catch (e) {
      console.warn("[Randy] BG send failed, falling back:", e);
    }
  }
  // Direct fallback (also used when background not available, e.g. orphaned tab)
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
 * POST an envelope to the Randy backend.
 * @param {object} payload - envelope fields (type, job, answer, ...)
 * @returns {Promise<object|null>} backend response (tagged with __randySeq)
 *   or null on failure
 */
async function postRandyEnvelope(payload) {
  const sessionId =
    typeof getRandySessionId === "function" ? getRandySessionId() : null;
  const preferences = await getRandyPreferences();
  const envelope = {
    session_id: sessionId,
    ...(payload || {}),
    ...(preferences ? { preferences } : {}),
  };
  const seq = ++randyEnvelopeSeq;
  return postViaBackgroundOrDirect(envelope, seq);
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

/**
 * Extract structured match_score from backend response.
 * New contract: POST /job-summary returns {reply, match_score: {answer, avg_score, preferences_score, qualifications_score, works[], misses[]}}
 * Falls back to payload.match_score for legacy.
 * @param {object|null} data
 * @returns {{answer:string,avg_score:number,preferences_score:number,qualifications_score:number,works:string[],misses:string[]}|null}
 */
function getRandyMatchScore(data) {
  if (!data || typeof data !== "object") return null;
  const ms = data.match_score || (data.payload && data.payload.match_score) || null;
  if (!ms || typeof ms !== "object") return null;
  const avg = typeof ms.avg_score === "number" ? ms.avg_score : typeof ms.avg === "number" ? ms.avg : null;
  const pref = typeof ms.preferences_score === "number" ? ms.preferences_score : typeof ms.preferences === "number" ? ms.preferences : null;
  const qual = typeof ms.qualifications_score === "number" ? ms.qualifications_score : typeof ms.qualifications === "number" ? ms.qualifications : typeof ms.portfolio_score === "number" ? ms.portfolio_score : null;
  if (avg === null || pref === null || qual === null) return null;
  const works = Array.isArray(ms.works) ? ms.works.filter((s) => typeof s === "string" && s.trim()) : [];
  const misses = Array.isArray(ms.misses) ? ms.misses.filter((s) => typeof s === "string" && s.trim()) : [];
  const answer = typeof ms.answer === "string" ? ms.answer.trim() : typeof data.reply === "string" ? data.reply.trim() : "";
  return { answer, avg_score: avg, preferences_score: pref, qualifications_score: qual, works, misses };
}

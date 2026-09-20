/* Randy background service worker — cover-letter & resume silent download.

   Owns delivery paths:
     POST /cover-letters -> {job_id} -> poll GET /cover-letters/{id}/status
     POST /resumes       -> {job_id} -> poll GET /resumes/{id}/status
     -> chrome.downloads.download({url: GET /{type}/{id}.pdf, saveAs:false})

   DO NOT use FileReader / URL.createObjectURL / blob reconstruction here —
   MV3 service workers have unreliable Blob URL lifetime. The download is
   triggered directly from the server URL so Chrome handles the fetch + write.

   Also note: chrome.downloads.download() does NOT support a `headers` field.
   Auth (if ever added) must be via query param / signed URL, not Bearer header.
*/

// Try to load shared config first (service worker global is isolated from content scripts)
try {
  if (typeof importScripts === "function") {
    importScripts("../config.js");
  }
} catch (_) {}
const SERVER_ORIGIN = (typeof BACKEND_URL !== "undefined" && BACKEND_URL ? BACKEND_URL : "http://127.0.0.1:5000").replace(/\/+$/, "");

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
  });
}

// Track downloadId -> {jobId, type: "cover-letter"|"resume"} for onChanged forwarding
const downloadIdToJobId = new Map();

// ---------------------------------------------------------------------------
// Core: trigger silent downloads
// ---------------------------------------------------------------------------

/**
 * Trigger a silent download for a ready document.
 * @param {string} jobId
 * @param {"cover-letter"|"resume"} type
 * @returns {Promise<number>} downloadId
 */
async function requestDocument(jobId, type) {
  if (!jobId || typeof jobId !== "string") throw new Error("Missing jobId");
  const isResume = type === "resume";
  const path = isResume ? `/resumes/${jobId}.pdf` : `/cover-letters/${jobId}.pdf`;
  const filename = isResume ? "resume.pdf" : "cover_letter.pdf";
  const url = `${SERVER_ORIGIN}${path}`;
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
  downloadIdToJobId.set(downloadId, { jobId, type: isResume ? "resume" : "cover-letter" });
  console.log(`[Randy BG] download started: ${type} job ${jobId} -> downloadId ${downloadId}`);
  return downloadId;
}

async function requestCoverLetter(jobId) {
  return requestDocument(jobId, "cover-letter");
}

async function requestResume(jobId) {
  return requestDocument(jobId, "resume");
}

/**
 * Poll status until ready, then trigger download.
 * @param {string} jobId
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=1000]
 * @param {number} [opts.timeoutMs=30000]
 * @param {"cover-letter"|"resume"} [opts.type="cover-letter"]
 * @returns {Promise<number>} downloadId
 */
async function pollAndDownload(jobId, opts = {}) {
  const intervalMs = opts.intervalMs || 1000;
  const timeoutMs = opts.timeoutMs || 30000;
  const type = opts.type === "resume" ? "resume" : "cover-letter";
  const statusPath = type === "resume" ? `/resumes/${jobId}/status` : `/cover-letters/${jobId}/status`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let resp;
    try {
      resp = await fetch(`${SERVER_ORIGIN}${statusPath}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
    } catch (e) {
      console.warn("[Randy BG] status poll network error:", e);
      await sleep(intervalMs);
      continue;
    }

    if (resp.status === 404) {
      const body = await resp.json().catch(() => null);
      throw new Error(body?.message || "Job not found or expired");
    }

    const data = await resp.json().catch(() => null);
    const status = data?.status;

    if (status === "ready") {
      return type === "resume" ? requestResume(jobId) : requestCoverLetter(jobId);
    }
    if (status === "error") {
      throw new Error(data?.error || (type === "resume" ? "Resume generation failed" : "Cover letter generation failed"));
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${type} (30s)`);
}

async function pollAndDownloadResume(jobId, opts = {}) {
  return pollAndDownload(jobId, { ...opts, type: "resume" });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// chrome.downloads listeners — surface completion back to content/popup
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.downloads) {
  try {
    chrome.downloads.onDeterminingFilename.addListener((item) => {
      const entry = downloadIdToJobId.get(item.id);
      if (entry) {
        const jid = typeof entry === "string" ? entry : entry.jobId;
        console.log(`[Randy BG] determining filename for job ${jid}: ${item.filename}`);
      }
    });
  } catch (e) {
    console.warn("[Randy BG] onDeterminingFilename not available:", e);
  }

  chrome.downloads.onChanged.addListener((delta) => {
    const entry = downloadIdToJobId.get(delta.id);
    if (!entry) return;
    const jobId = typeof entry === "string" ? entry : entry.jobId;
    const docType = typeof entry === "string" ? "cover-letter" : (entry.type || "cover-letter");
    const msgType = docType === "resume" ? "resume_download" : "cover_letter_download";

    if (delta.state && delta.state.current === "complete") {
      console.log(`[Randy BG] download complete: ${docType} job ${jobId} downloadId ${delta.id}`);
      broadcastToTabs({ type: msgType, status: "complete", jobId, downloadId: delta.id });
      downloadIdToJobId.delete(delta.id);
    } else if (delta.state && delta.state.current === "interrupted") {
      console.warn(`[Randy BG] download interrupted: ${docType} job ${jobId} downloadId ${delta.id}`, delta);
      broadcastToTabs({ type: msgType, status: "interrupted", jobId, downloadId: delta.id, error: delta.error?.current || "interrupted" });
      downloadIdToJobId.delete(delta.id);
    } else if (delta.error) {
      console.warn(`[Randy BG] download error: ${docType} job ${jobId}`, delta.error);
      broadcastToTabs({ type: msgType, status: "error", jobId, downloadId: delta.id, error: delta.error.current });
    }
  });
}

async function broadcastToTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (_) {
        // Tab may not have content script — ignore
      }
    }
  } catch (e) {
    console.warn("[Randy BG] broadcast failed:", e);
  }
  // Also try runtime broadcast for popup/other listeners
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Message bridge: content script asks background to poll + download
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  // Track: open the settings page, which carries the Application tracker
  // link. Content scripts have no chrome.runtime.openOptionsPage, so it has
  // to happen here. options_ui sets open_in_tab, so this lands in a tab.
  if (msg.type === "open-settings") {
    try {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
    } catch (e) {
      console.warn("[Randy BG] openOptionsPage failed:", e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
    return true;
  }

  // Simple direct download (caller already polled or knows it's ready)
  if (msg.type === "download-cover-letter" && msg.jobId) {
    requestCoverLetter(msg.jobId)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === "download-resume" && msg.jobId) {
    requestResume(msg.jobId)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  // One-shot: poll until ready then download (preferred for new POST flow)
  if (msg.type === "poll-and-download-cover-letter" && msg.jobId) {
    pollAndDownload(msg.jobId, { intervalMs: msg.intervalMs, timeoutMs: msg.timeoutMs, type: "cover-letter" })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === "poll-and-download-resume" && msg.jobId) {
    pollAndDownloadResume(msg.jobId, { intervalMs: msg.intervalMs, timeoutMs: msg.timeoutMs })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  // Allow content script to create a cover-letter job directly via background
  // Preferences are REQUIRED (chrome.storage) — no env fallback, mirrors resumes
  if (msg.type === "create-cover-letter" && msg.description) {
    const sessionId = msg.sessionId || "default";
    fetch(`${SERVER_ORIGIN}/cover-letters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, description: msg.description, job: msg.job || null, preferences: msg.preferences || null }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message || `Server ${r.status}`);
        return body;
      })
      .then((body) => sendResponse({ ok: true, jobId: body.job_id, status: body.status }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === "create-resume" && msg.description) {
    const sessionId = msg.sessionId || "default";
    fetch(`${SERVER_ORIGIN}/resumes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, description: msg.description, job: msg.job || null, preferences: msg.preferences || null }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message || `Server ${r.status}`);
        return body;
      })
      .then((body) => sendResponse({ ok: true, jobId: body.job_id, status: body.status }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  // Job-summary via background — bypasses CORS + CSP/PNA (content fetch
  // from https://www.linkedin.com / greenhouse to https://*.up.railway.app
  // is blocked by page connect-src and CORS preflight; background fetch is
  // privileged and host_permissions allows it without CORS).
  if (msg.type === "randy-job-summary" && msg.envelope) {
    fetch(`${SERVER_ORIGIN}/job-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.envelope),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message || `Server ${r.status}`);
        return body;
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  // Profile fetch via background — bypasses page CSP / PNA (content fetch
  // from https://boards.greenhouse.io to http://127.0.0.1 is blocked by
  // connect-src and Private Network Access; background fetch is privileged).
  if (msg.type === "get-profile") {
    fetch(`${SERVER_ORIGIN}/profile`, {
      method: msg.preferences ? "POST" : "GET",
      headers: msg.preferences
        ? { "Content-Type": "application/json", Accept: "application/json" }
        : { Accept: "application/json" },
      ...(msg.preferences ? { body: JSON.stringify({ preferences: msg.preferences }) } : {}),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message || `profile responded ${r.status}`);
        return body;
      })
      .then((profile) => sendResponse({ ok: true, profile }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  return false;
});

console.log("[Randy BG] background service worker loaded");

/* Randy background service worker — cover-letter silent download.

   Owns the new delivery path:
     POST /cover-letters -> {job_id} -> poll GET /cover-letters/{id}/status
     -> chrome.downloads.download({url: GET /cover-letters/{id}.pdf, saveAs:false})

   DO NOT use FileReader / URL.createObjectURL / blob reconstruction here —
   MV3 service workers have unreliable Blob URL lifetime. The download is
   triggered directly from the server URL so Chrome handles the fetch + write.

   Also note: chrome.downloads.download() does NOT support a `headers` field.
   Auth (if ever added) must be via query param / signed URL, not Bearer header.
*/

const SERVER_ORIGIN = "http://127.0.0.1:5000";

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
  });
}

// Track downloadId -> jobId for onChanged forwarding
const downloadIdToJobId = new Map();

// ---------------------------------------------------------------------------
// Core: trigger a silent download from the server URL
// ---------------------------------------------------------------------------

/**
 * Trigger a silent download for a ready cover letter.
 * @param {string} jobId - uuid4 from POST /cover-letters
 * @returns {Promise<number>} downloadId from chrome.downloads
 */
async function requestCoverLetter(jobId) {
  if (!jobId || typeof jobId !== "string") {
    throw new Error("Missing jobId");
  }
  const url = `${SERVER_ORIGIN}/cover-letters/${jobId}.pdf`;
  const downloadId = await chrome.downloads.download({
    url,
    filename: "cover_letter.pdf",
    saveAs: false,
    conflictAction: "uniquify",
  });
  downloadIdToJobId.set(downloadId, jobId);
  console.log(`[Randy BG] download started: job ${jobId} -> downloadId ${downloadId}`);
  return downloadId;
}

/**
 * Poll status until ready, then trigger download.
 * Used when caller wants one-shot "generate then download".
 * @param {string} jobId
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=1000]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<number>} downloadId
 */
async function pollAndDownload(jobId, opts = {}) {
  const intervalMs = opts.intervalMs || 1000;
  const timeoutMs = opts.timeoutMs || 30000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let resp;
    try {
      resp = await fetch(`${SERVER_ORIGIN}/cover-letters/${jobId}/status`, {
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
      return requestCoverLetter(jobId);
    }
    if (status === "error") {
      throw new Error(data?.error || "Cover letter generation failed");
    }
    // pending -> continue polling
    await sleep(intervalMs);
  }

  throw new Error("Timed out waiting for cover letter (30s)");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// chrome.downloads listeners — surface completion back to content/popup
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.downloads) {
  // Fires when filename is determined (useful for logging)
  try {
    chrome.downloads.onDeterminingFilename.addListener((item) => {
      if (downloadIdToJobId.has(item.id)) {
        console.log(`[Randy BG] determining filename for job ${downloadIdToJobId.get(item.id)}: ${item.filename}`);
      }
    });
  } catch (e) {
    console.warn("[Randy BG] onDeterminingFilename not available:", e);
  }

  chrome.downloads.onChanged.addListener((delta) => {
    const jobId = downloadIdToJobId.get(delta.id);
    if (!jobId) return;

    // Delta has {id, state: {current:"complete"|"interrupted"}}
    if (delta.state && delta.state.current === "complete") {
      console.log(`[Randy BG] download complete: job ${jobId} downloadId ${delta.id}`);
      // Notify any open tabs (content scripts) — best-effort
      broadcastToTabs({ type: "cover_letter_download", status: "complete", jobId, downloadId: delta.id });
      downloadIdToJobId.delete(delta.id);
    } else if (delta.state && delta.state.current === "interrupted") {
      console.warn(`[Randy BG] download interrupted: job ${jobId} downloadId ${delta.id}`, delta);
      broadcastToTabs({ type: "cover_letter_download", status: "interrupted", jobId, downloadId: delta.id, error: delta.error?.current || "interrupted" });
      downloadIdToJobId.delete(delta.id);
    } else if (delta.error) {
      console.warn(`[Randy BG] download error: job ${jobId}`, delta.error);
      broadcastToTabs({ type: "cover_letter_download", status: "error", jobId, downloadId: delta.id, error: delta.error.current });
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

  // Simple direct download (caller already polled or knows it's ready)
  if (msg.type === "download-cover-letter" && msg.jobId) {
    requestCoverLetter(msg.jobId)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true; // keep channel open for async sendResponse
  }

  // One-shot: poll until ready then download (preferred for new POST flow)
  if (msg.type === "poll-and-download-cover-letter" && msg.jobId) {
    pollAndDownload(msg.jobId, { intervalMs: msg.intervalMs, timeoutMs: msg.timeoutMs })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  // Allow content script to create a cover-letter job directly via background
  // (keeps service worker alive during long polls if needed)
  if (msg.type === "create-cover-letter" && msg.description) {
    const sessionId = msg.sessionId || "default";
    fetch(`${SERVER_ORIGIN}/cover-letters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, description: msg.description, job: msg.job || null }),
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

  return false;
});

console.log("[Randy BG] background service worker loaded");

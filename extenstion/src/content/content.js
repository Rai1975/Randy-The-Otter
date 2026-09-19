console.log("Randy loaded!");

// After an extension reload/update, content scripts already running in open
// tabs become ORPHANED: chrome.runtime.id is undefined and getURL() returns
// "chrome-extension://invalid/..." — every image/font request then fails and
// stacks. Detect that here, warn once, and never fire invalid requests.
// (Real fix on reload: refresh the LinkedIn tab.)
const RANDY_EXTENSION_OK = Boolean(
  typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id
);

if (!RANDY_EXTENSION_OK) {
  console.warn(
    "[Randy] Extension context invalid (orphaned script after reload). " +
      "Refresh the LinkedIn tab to reload Randy."
  );
}

// Sprite map — default is "idle". Future states just add entries here
// (e.g. happy, sad) and call setRandySprite(name).
const RANDY_SPRITES = {
  idle: RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/idle-alert.gif")
    : null,
  talking: RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/talk.gif")
    : null,
};

let currentSprite = "idle";

// Preload all sprites so future idle <-> talking swaps don't flicker.
// Skipped entirely when orphaned — no invalid requests.
if (RANDY_EXTENSION_OK) {
  Object.values(RANDY_SPRITES).forEach((url) => {
    const preload = new Image();
    preload.src = url;
  });
}

// Pixel font loads here (not in static CSS) so an orphaned script never
// fires a font request. Orphaned tabs simply render the fallback stack
// declared in content.css ("Courier New", monospace).
if (
  RANDY_EXTENSION_OK &&
  typeof FontFace !== "undefined" &&
  document.fonts
) {
  try {
    const randyFont = new FontFace(
      "Press Start 2P",
      `url(${chrome.runtime.getURL(
        "src/assets/press-start-2p-latin.woff2"
      )}) format("woff2")`,
      { weight: "400", style: "normal" }
    );
    randyFont
      .load()
      .then((loadedFont) => document.fonts.add(loadedFont))
      .catch(() => {});
  } catch {
    // Font is decorative — fallbacks cover any failure silently.
  }
}

// ---------------------------------------------------------------------------
// Handshake cache helpers (bridge-provided, parsed-only, ephemeral)
// ---------------------------------------------------------------------------
// handshake-bridge.js (document_start, ISOLATED) populates
// window.__randyHandshakeJobCache keyed by URL jobId (= GraphQL job.id).
// All GetExtendedJobDetails batches on the search page land here at the
// start; lost on refresh / ?page= change by design. Backend wiring is
// deferred — these helpers just expose the cache for upcoming API calls.
//
//   getHandshakeCachedJobForCurrentUrl() -> {parsed, jobId, url, timestamp}|null
//   getHandshakeCachedJobById(id)        -> same or null
//   getHandshakeCacheSnapshot()          -> { [jobId]: parsed }
// Content.js and bridge share the same ISOLATED world, so window.* is shared.

function getHandshakeCachedJobForCurrentUrl() {
  try {
    if (typeof window.getCurrentHandshakeJob === "function") return window.getCurrentHandshakeJob();
    if (typeof getCurrentHandshakeJob === "function") return getCurrentHandshakeJob();
  } catch (_e) {}
  return null;
}

function getHandshakeCachedJobById(jobId) {
  try {
    if (typeof window.getHandshakeCachedJob === "function") return window.getHandshakeCachedJob(jobId);
    if (typeof getHandshakeCachedJob === "function") return getHandshakeCachedJob(jobId);
  } catch (_e) {}
  return null;
}

function getHandshakeCacheSnapshot() {
  try {
    if (typeof window.__randyHandshakeJobs === "function") return window.__randyHandshakeJobs();
  } catch (_e) {}
  try {
    if (window.__randyHandshakeJobCache) {
      var out = {};
      var keys = Object.keys(window.__randyHandshakeJobCache);
      for (var i = 0; i < keys.length; i++) out[keys[i]] = window.__randyHandshakeJobCache[keys[i]].parsed;
      return out;
    }
  } catch (_e) {}
  return {};
}

// Example future wiring (DO NOT enable yet — backend hook deferred):
//   var entry = getHandshakeCachedJobForCurrentUrl();
//   if (entry) {
//     // send via API keyed by entry.jobId (URL trailing id == job.id)
//     // payload: { site:"handshake", jobId: entry.jobId, ...entry.parsed }
//     // postRandyEnvelope({ type:"job", job: { site:"handshake", jobId: entry.jobId, ...entry.parsed }, trigger: action })
//   }

/**
 * Swap Randy's displayed gif.
 * @param {keyof typeof RANDY_SPRITES} name - sprite key from RANDY_SPRITES
 * @returns {boolean} true if swapped, false on unknown name
 */
function setRandySprite(name) {
  if (!RANDY_SPRITES[name]) {
    console.warn(`[Randy] Unknown sprite: "${name}"`);
    return false;
  }

  const img = document.querySelector("#randy-character");
  if (!img) {
    console.warn("[Randy] Character image not found yet.");
    return false;
  }

  currentSprite = name;
  img.src = RANDY_SPRITES[name];
  return true;
}

// ---------------------------------------------------------------------------
// Cover-letter new path — no Blob / FileReader / URL.createObjectURL.
// The background service worker owns chrome.downloads.download() (MV3 safe).
// ---------------------------------------------------------------------------
const RANDY_COVER_LETTER_ORIGIN = "http://127.0.0.1:5000";
const RANDY_COVER_LETTER_POLL_MS = 1000;
const RANDY_COVER_LETTER_TIMEOUT_MS = 30000;

/**
 * Ask the background SW to poll status and trigger a silent download.
 * Falls back to direct fetch+poll if chrome.runtime is unavailable (e.g. orphaned).
 * @param {string} jobId
 * @returns {Promise<{ok:boolean, downloadId?:number, error?:string}>}
 */
function requestCoverLetterDownload(jobId) {
  if (!jobId) return Promise.resolve({ ok: false, error: "Missing jobId" });

  // Preferred: delegate to background SW (keeps MV3 Blob-free, silent saveAs:false)
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "poll-and-download-cover-letter", jobId }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "No response from background" });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || String(e) });
      }
    });
  }

  // Fallback (should not happen in MV3 with background) — poll here then trigger anchor
  console.warn("[Randy] background unavailable, polling from content script");
  return pollCoverLetterThenDownloadFallback(jobId);
}

async function pollCoverLetterThenDownloadFallback(jobId) {
  const deadline = Date.now() + RANDY_COVER_LETTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${RANDY_COVER_LETTER_ORIGIN}/cover-letters/${jobId}/status`);
      if (r.status === 404) {
        const b = await r.json().catch(() => null);
        return { ok: false, error: b?.message || "Job expired" };
      }
      const data = await r.json().catch(() => null);
      if (data?.status === "ready") {
        // Last resort: direct navigation to PDF URL (will show save dialog if downloads permission missing)
        window.open(`${RANDY_COVER_LETTER_ORIGIN}/cover-letters/${jobId}.pdf`, "_blank");
        return { ok: true };
      }
      if (data?.status === "error") return { ok: false, error: data.error || "Generation failed" };
    } catch (e) {
      console.warn("[Randy] fallback poll error:", e);
    }
    await new Promise((res) => setTimeout(res, RANDY_COVER_LETTER_POLL_MS));
  }
  return { ok: false, error: "Timed out waiting for cover letter" };
}

// Listen for download completion broadcasts from background SW to update bubble
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "cover_letter_download") return false;
      if (msg.status === "complete") {
        console.log(`[Randy] cover letter download complete (job ${msg.jobId})`);
        if (typeof setBubbleText === "function" && typeof setBubbleVisible === "function") {
          setBubbleVisible(true);
          setBubbleText("cover letter downloaded bro — check your downloads!");
          if (typeof setChoicesVisible === "function") setChoicesVisible(false);
        }
      } else if (msg.status === "interrupted" || msg.status === "error") {
        console.warn(`[Randy] cover letter download failed:`, msg);
        if (typeof setBubbleText === "function" && typeof setBubbleVisible === "function") {
          setBubbleVisible(true);
          setBubbleText(`download failed bro — ${msg.error || "interrupted"}. try again?`);
          if (typeof setChoicesVisible === "function") setChoicesVisible(false);
        }
      }
      return false;
    });
  } catch (_) {}
}

function createRandy() {
  // Guard against double-injection on LinkedIn SPA navigations.
  if (document.getElementById("randy")) {
    return document.getElementById("randy");
  }

  const randy = document.createElement("div");
  randy.id = "randy";

  // Chat bubble lives in its own component (bubble.js / bubble.css).
  // Initial "..." is a loading placeholder only — the greeting text itself
  // always comes from the backend `reply` (session-scoped).
  const { wrap: bubbleWrap } = createBubble("...");

  const character = document.createElement("img");
  character.id = "randy-character";
  // Only set src for real extension URLs — never chrome-extension://invalid/.
  if (RANDY_SPRITES[currentSprite]) {
    character.src = RANDY_SPRITES[currentSprite];
  }
  character.alt = "Randy the Otter";
  character.draggable = false;

  // If the gif fails to load (missing resource, CSP), keep the bubble usable.
  character.addEventListener("error", () => {
    console.warn("[Randy] Failed to load sprite:", character.src);
    character.style.display = "none";
  });

  // No greeting on page load: the bubble stays invisible until the backend
  // actually has a comment to make (random gate on ambient job sightings).
  // Yes/No answers POST { session_id, type: "answer", about_job }; reply
  // drives bubble. While a "Did you apply?" prompt is pending, the answer
  // carries the job identity so the backend can log it on "yes".
  async function handleRandyAnswer(answer) {
    if (typeof sendRandyEvent !== "function") {
      return;
    }
    const aboutJob =
      window.__randyPendingQuestion && typeof window.__randyPendingQuestion === "object"
        ? window.__randyPendingQuestion
        : undefined;
    try {
      const data = await sendRandyEvent("answer", { answer, about_job: aboutJob });
      if (typeof setBubbleFromBackend === "function") {
        setBubbleFromBackend(data);
      }
    } catch (error) {
      console.warn("[Randy] Answer send failed:", error);
    } finally {
      // Single question at a time — answering clears the pending slot and
      // lets the deferred dwell post for the new page fire (see watcher).
      window.__randyPendingQuestion = null;
      if (window.__randyPendingDwellUrl && typeof scrapeCurrentJob === "function") {
        const url = window.__randyPendingDwellUrl;
        window.__randyPendingDwellUrl = null;
        if (window.location.href === url) {
          scrapeCurrentJob().catch((e) => console.warn("[Randy] Deferred dwell failed:", e));
        }
      }
    }
  }

  // Click now just toggles the action menu (hover still opens it too).
  // No job message is forced on click — Roast owns that flow.
  // Yes/No buttons and menu items stopPropagation, so answering / picking
  // an action never retriggers this toggle.
  randy.addEventListener("click", () => {
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (typeof isMenuVisible === "function" && typeof setMenuVisible === "function") {
      setMenuVisible(!isMenuVisible());
    } else if (typeof setMenuVisible === "function") {
      setMenuVisible(true);
    }
  });

  /**
   * Generic menu action handler:
   * - cover-letter: new path POST /cover-letters -> background SW downloads
   *   via chrome.downloads.download({saveAs:false}) — no Blob/anchor in content.
   * - roast / match-score: legacy POST /job-summary via sendRandyEvent.
   * While a "Did you apply?" question is pending the handler is suppressed.
   */
  async function handleMenuAction(action) {
    if (window.__randyPendingQuestion) {
      console.log(`[Randy] Menu action "${action}" suppressed while question pending`);
      if (typeof setMenuVisible === "function") {
        setMenuVisible(false);
      }
      return;
    }
    if (typeof setMenuVisible === "function") {
      setMenuVisible(false);
    }
    const isCoverLetter = action === "cover-letter";

    // Cover-letter: dedicated endpoint + silent background download
    if (isCoverLetter) {
      if (typeof setBubbleVisible === "function") setBubbleVisible(true);
      if (typeof setBubbleText === "function") setBubbleText("cooking your cover letter bro...");
      if (typeof setChoicesVisible === "function") setChoicesVisible(false);
      try {
        let job = null;
        if (typeof scrapeCurrentJob === "function") {
          job = await scrapeCurrentJob({ report: false });
        }
        const description = job && typeof job.description === "string" ? job.description : null;
        if (!description || !description.trim()) {
          if (typeof setBubbleText === "function") setBubbleText("bro there's no description on this one — can't cook a letter");
          return;
        }
        const sessionId = typeof getRandySessionId === "function" ? getRandySessionId() : "default";
        // Kick off generation (202 -> job_id), then delegate poll+download to background SW
        const createResp = await fetch(`${RANDY_COVER_LETTER_ORIGIN}/cover-letters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, description, job }),
        });
        const createBody = await createResp.json().catch(() => null);
        if (!createResp.ok) {
          const msg = createBody?.message || `Server ${createResp.status}`;
          throw new Error(msg);
        }
        const jobId = createBody && createBody.job_id;
        if (!jobId) throw new Error("No job_id returned");
        console.log(`[Randy] cover-letter job created: ${jobId}`);

        if (typeof setBubbleText === "function") setBubbleText("letter's cooking... will download automatically when ready");

        const dlResult = await requestCoverLetterDownload(jobId);
        if (!dlResult.ok) {
          const err = dlResult.error || "download failed";
          // Surface 404/expired/timeout visibly, not silently
          if (/expired|not found|404/i.test(err)) {
            if (typeof setBubbleText === "function") setBubbleText("bro that letter expired — hit cover letter again?");
          } else if (/timed out/i.test(err)) {
            if (typeof setBubbleText === "function") setBubbleText("bro it's taking forever — try again in a sec?");
          } else {
            if (typeof setBubbleText === "function") setBubbleText(`bro something broke — ${err}`);
          }
          console.warn("[Randy] cover-letter download error:", dlResult);
          return;
        }
        // Success: background will broadcast "complete" -> bubble update there.
        // Give immediate feedback too.
        if (typeof setBubbleText === "function") setBubbleText("downloading your letter bro...");
      } catch (error) {
        console.warn(`[Randy] cover-letter failed:`, error);
        if (typeof setBubbleText === "function") {
          const msg = error && error.message ? error.message : String(error);
          if (/expired/i.test(msg)) setBubbleText("bro that letter expired — try again?");
          else setBubbleText(`cover letter failed bro — ${msg}`);
        }
      }
      return;
    }

    // Non-cover-letter actions: legacy job-summary path
    if (typeof setBubbleVisible === "function") {
      setBubbleVisible(true);
    }
    setBubbleText("...");
    try {
      let job = null;
      if (typeof scrapeCurrentJob === "function") {
        job = await scrapeCurrentJob({ report: false });
      }
      let data = null;
      if (typeof sendRandyEvent === "function") {
        data = await sendRandyEvent("job", { job, action, trigger: action });
      }
      if (data) {
        if (data.payload) {
          console.log(`[Randy] ${action} payload:`, data.payload);
        }
        if (typeof setBubbleFromBackend === "function") {
          setBubbleFromBackend(data);
        }
      } else if (typeof setBubbleVisible === "function") {
        setBubbleVisible(false);
      }
    } catch (error) {
      console.warn(`[Randy] ${action} failed:`, error);
      if (typeof setBubbleVisible === "function") {
        setBubbleVisible(false);
      }
    }
  }

  async function handleRoast() {
    return handleMenuAction("roast");
  }

  randy.appendChild(bubbleWrap);
  randy.appendChild(character);
  document.body.appendChild(randy);

  if (typeof createChoiceButtons === "function") {
    createChoiceButtons(handleRandyAnswer);
  }

  // Hover menu: all three actions talk to the backend job endpoint
  // (explicit actions bypass the random gate). payload-bearing replies
  // (cover-letter LaTeX) are console.logged for now; future: pdf download.
  if (typeof createMenu === "function") {
    createMenu((actionId) => {
      handleMenuAction(actionId);
    });
  }

  const HOVER_MENU_DELAY_MS = 1000;
  // Grace period before the open menu closes after the mouse leaves, so
  // briefly slipping off Randy doesn't instantly dismiss it. Re-entering
  // in time cancels the close.
  const HOVER_MENU_HIDE_DELAY_MS = 2500;
  randy.addEventListener("mouseenter", () => {
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (window.__randyMenuHideTimer) {
      clearTimeout(window.__randyMenuHideTimer);
      window.__randyMenuHideTimer = null;
    }
    window.__randyHoverTimer = setTimeout(() => {
      window.__randyHoverTimer = null;
      if (typeof setMenuVisible === "function") {
        setMenuVisible(true);
      }
    }, HOVER_MENU_DELAY_MS);
  });
  randy.addEventListener("mouseleave", () => {
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (window.__randyMenuHideTimer) {
      clearTimeout(window.__randyMenuHideTimer);
    }
    window.__randyMenuHideTimer = setTimeout(() => {
      window.__randyMenuHideTimer = null;
      if (typeof setMenuVisible === "function") {
        setMenuVisible(false);
      }
    }, HOVER_MENU_HIDE_DELAY_MS);
  });

  return randy;
}

createRandy();

// Dwell-gated auto-scrape: fire only after the user sits on the same URL
// for 2s. LinkedIn is an SPA (no reloads between jobs), so watch for URL
// changes and restart the timer. Same page-load session_id is reused —
// no refresh needed. The scraper renders the backend job `reply` itself.
(function startDwellScrape() {
  if (typeof scrapeCurrentJob !== "function") {
    return;
  }

  // Same isolated world survives re-injection after an extension reload, so
  // a previous instance's timers may still be alive — clear them first or
  // intervals/scrapes stack up.
  if (window.__randyDwellTimer) {
    clearTimeout(window.__randyDwellTimer);
    window.__randyDwellTimer = null;
  }
  if (window.__randyDwellWatcher) {
    clearInterval(window.__randyDwellWatcher);
    window.__randyDwellWatcher = null;
  }

  const DWELL_MS = 2000;
  let lastUrl = window.location.href;

  function schedule() {
    if (window.__randyDwellTimer) {
      clearTimeout(window.__randyDwellTimer);
    }
    window.__randyDwellTimer = setTimeout(() => {
      window.__randyDwellTimer = null;
      if (window.location.href === lastUrl) {
        scrapeCurrentJob().catch((error) => {
          console.warn("[Randy] Dwell scrape failed:", error);
        });
      }
    }, DWELL_MS);
  }

  schedule();
  window.__randyDwellWatcher = setInterval(() => {
    if (window.location.href !== lastUrl) {
      const previousJob = window.__randyLastJob;
      const previousUrl = window.__randyLastJobUrl;
      lastUrl = window.location.href;
      // One conversation at a time: if a "Did you apply?" is already pending,
      // don't fire the dwell comment for the new page yet — defer it until
      // the user answers (see handleRandyAnswer's finally block).
      const hasPending = Boolean(window.__randyPendingQuestion);
      // Fire the dwell scrape for the new page unless we're mid-question.
      if (!hasPending) {
        schedule();
      } else {
        // Remember where we are so the deferred post can still fire later.
        window.__randyPendingDwellUrl = lastUrl;
      }
      // Ask about the posting just left, once per (source, job_id) session.
      if (
        previousJob &&
        previousJob.jobId &&
        previousUrl !== lastUrl &&
        typeof sendRandyEvent === "function" &&
        typeof setBubbleFromBackend === "function"
      ) {
        const key =
          typeof randyJobKey === "function"
            ? randyJobKey(previousJob.site || previousJob.source, previousJob.jobId)
            : null;
        const askedSet = window.__randyAskedJobs || (window.__randyAskedJobs = new Set());
        // Only ask when we have a stable identity to log; otherwise the
        // yes/no buttons can't usefully record anything.
        if (key && !askedSet.has(key)) {
          askedSet.add(key);
          const capture = {
            source: previousJob.site || previousJob.source || null,
            job_id: previousJob.jobId,
            jobId: previousJob.jobId,
            site: previousJob.site || previousJob.source || null,
            title: previousJob.title || null,
          };
          // Replace any pending question — latest switch wins.
          window.__randyPendingQuestion = capture;
          sendRandyEvent("job-switch", { previous_job: capture })
            .then((data) => {
              // Don't render stale asks (overwritten by a faster subsequent
              // switch). The latest switch's pending capture is authoritative.
              if (window.__randyPendingQuestion !== capture) return;
              setBubbleFromBackend(data);
            })
            .catch((error) => {
              console.warn("[Randy] job-switch failed:", error);
            });
        } else if (!key) {
          console.warn("[Randy] Skipping applied prompt — no job identity:", previousJob);
        }
      }
    }
  }, 500);
})();

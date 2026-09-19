/* Handshake GraphQL bridge — isolated content-script world.
 *
 * Responsibilities:
 *   1. Listen for window.postMessage events of type HS_SCRAPER_JOB_DATA from
 *      the MAIN-world handshake-interceptor.js (declared via manifest
 *      content_scripts with "world": "MAIN" at document_start) and cache them.
 *   2. Expose parsed-only cache keyed by URL jobId for upcoming
 *      cover-letter / match-score API calls (backend wiring deferred).
 *
 * Load order: handshake-interceptor.js runs in MAIN world at document_start
 * (patches page's fetch/XHR before app code fires). This bridge runs in
 * ISOLATED world at document_start and only handles the postMessage relay.
 * The existing document_idle entry (content.js etc.) stays untouched.
 */

// Guard against double-registration on SPA navigations or extension reloads.
(function () {
  "use strict";

  var BRIDGE_TAG = "[Randy][Handshake Bridge]";
  var MAX_CACHE_ENTRIES = 50;

  var extensionOk = Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);

  if (!extensionOk) {
    console.warn(BRIDGE_TAG + " Extension context invalid (orphaned script after reload). Refresh the Handshake tab.");
    return;
  }

  if (window.__randyHandshakeBridgeInjected) {
    return;
  }
  window.__randyHandshakeBridgeInjected = true;

  // --- In-memory cache (parsed-only, ephemeral) ---------------------------
  // Lost on refresh naturally; explicitly cleared when ?page= changes since
  // the search page fetches a fresh batch of jobs on pagination.

  /** @type {Object<string, {parsed: object, jobId: string, url: string|null, timestamp: number}>} */
  window.__randyHandshakeJobCache = window.__randyHandshakeJobCache || {};
  window.__randyHandshakeJobPage = window.__randyHandshakeJobPage || window.location.search;

  function getHandshakeJobIdFromUrl(url) {
    try {
      var href = url || window.location.href;
      var u = new URL(href, window.location.origin);
      // Primary: trailing /<digits> in pathname (e.g. /job-search/123456)
      var m = u.pathname.match(/(\d+)\/?$/);
      if (m) return m[1];
      // Fallback: ?id= param (some Handshake routes)
      var qp = u.searchParams.get("id");
      if (qp) return qp;
      return null;
    } catch (_e) {
      return null;
    }
  }

  function maybeInvalidateCacheOnPageChange() {
    try {
      var curSearch = window.location.search;
      if (curSearch !== window.__randyHandshakeJobPage) {
        // ?page= (or any search change) means a new batch of jobs — drop old ones
        window.__randyHandshakeJobCache = {};
        window.__randyHandshakeJobPage = curSearch;
        console.log(BRIDGE_TAG + " Cleared job cache on page/search change:", curSearch);
      }
    } catch (_e) {}
  }

  function pruneCacheIfNeeded() {
    var keys = Object.keys(window.__randyHandshakeJobCache);
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    // Evict oldest entries first
    keys.sort(function (a, b) {
      return (window.__randyHandshakeJobCache[a].timestamp || 0) - (window.__randyHandshakeJobCache[b].timestamp || 0);
    });
    var toRemove = keys.length - MAX_CACHE_ENTRIES;
    for (var i = 0; i < toRemove; i++) {
      delete window.__randyHandshakeJobCache[keys[i]];
    }
  }

  function storeHandshakeJob(parsed, jobId, meta) {
    maybeInvalidateCacheOnPageChange();
    if (!parsed || typeof parsed !== "object") return;
    // Key is URL jobId == GraphQL job.id per design; fall back to current URL id if missing
    var key = jobId ? String(jobId) : getHandshakeJobIdFromUrl(meta && meta.url ? meta.url : null) || getHandshakeJobIdFromUrl();
    if (!key) {
      // No stable id — keep it still but keyed by timestamp so it doesn't collide
      console.warn(BRIDGE_TAG + " No jobId for parsed job — skipping cache (no URL id):", parsed);
      return;
    }
    window.__randyHandshakeJobCache[key] = {
      parsed: parsed,
      jobId: key,
      url: (meta && meta.url) || window.location.href,
      timestamp: Date.now(),
    };
    pruneCacheIfNeeded();
    console.log(BRIDGE_TAG + " Cached parsed job:", { jobId: key, parsed: parsed });
  }

  // Helpers for upcoming API wiring — content.js can call these without touching the cache directly
  window.getHandshakeJobIdFromUrl = getHandshakeJobIdFromUrl;
  window.getHandshakeCachedJob = function (jobId) {
    maybeInvalidateCacheOnPageChange();
    if (!jobId) return null;
    return window.__randyHandshakeJobCache[String(jobId)] || null;
  };
  window.getCurrentHandshakeJob = function () {
    maybeInvalidateCacheOnPageChange();
    var id = getHandshakeJobIdFromUrl();
    if (!id) return null;
    // Return entry {parsed, jobId, url, timestamp} or null
    return window.__randyHandshakeJobCache[String(id)] || null;
  };
  // Debug helper: list cached ids / count
  window.__randyHandshakeJobs = function () {
    maybeInvalidateCacheOnPageChange();
    var out = {};
    var keys = Object.keys(window.__randyHandshakeJobCache);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out[k] = window.__randyHandshakeJobCache[k].parsed;
    }
    console.log(BRIDGE_TAG + " Cache snapshot (" + keys.length + " entries):", out);
    return out;
  };

  // Also invalidate on SPA navigation (Handshake uses pushState)
  (function watchPageParam() {
    var lastSearch = window.location.search;
    var lastHref = window.location.href;
    setInterval(function () {
      if (window.location.search !== lastSearch || window.location.href !== lastHref) {
        lastSearch = window.location.search;
        lastHref = window.location.href;
        maybeInvalidateCacheOnPageChange();
      }
    }, 1000);
    try {
      window.addEventListener("popstate", maybeInvalidateCacheOnPageChange);
    } catch (_e) {}
  })();

  // --- Listen for MAIN world postMessage ---------------------------------

  window.addEventListener("message", function (event) {
    // Only accept messages from this window (MAIN world postMessage)
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.type !== "HS_SCRAPER_JOB_DATA") return;

    var payload = data.payload || data.data || data;

    // Parsed-only: payload = { parsed, jobId, operationName, url, timestamp }
    if (!payload || !payload.parsed) {
      console.warn(BRIDGE_TAG + " Received HS_SCRAPER_JOB_DATA with no parsed payload:", payload);
      return;
    }

    console.log(BRIDGE_TAG + " Received HS_SCRAPER_JOB_DATA (world boundary OK):", { jobId: payload.jobId, parsed: payload.parsed });

    storeHandshakeJob(payload.parsed, payload.jobId, { url: payload.url });

    // -------------------------------------------------------------------------
    // TODO (backend wiring deferred): when ready, callers in content.js can
    // do:
    //
    //   var entry = getCurrentHandshakeJob(); // or getHandshakeCachedJob(id)
    //   // entry.parsed is the GetExtendedJobDetails parsed fields for this URL's jobId
    //   // entry.jobId is the URL's trailing id (== job.id)
    //   // Send entry.parsed via API keyed by entry.jobId
    //
    // Example (do not enable yet):
    //   if (entry) {
    //     var sessionId = typeof getRandySessionId === "function" ? getRandySessionId() : "default";
    //     fetch("http://127.0.0.1:5000/job-summary", {
    //       method: "POST",
    //       headers: { "Content-Type": "application/json" },
    //       body: JSON.stringify({
    //         session_id: sessionId,
    //         type: "job",
    //         job: { site: "handshake", jobId: entry.jobId, ...entry.parsed, rawHandshakeParsed: entry.parsed },
    //         trigger: "handshake-interceptor"
    //       })
    //     });
    //   }
    // Keep console-only for now; just caching.
    // -------------------------------------------------------------------------
  });

  console.log(BRIDGE_TAG + " Bridge active — caching GetExtendedJobDetails parsed fields keyed by URL jobId — href:", window.location.href);
  // Expose manual check
  try {
    window.__randyHandshakeBridgeCheck = function () {
      maybeInvalidateCacheOnPageChange();
      return {
        href: window.location.href,
        bridgeActive: true,
        injected: window.__randyHandshakeBridgeInjected,
        extensionOk: extensionOk,
        cacheSize: Object.keys(window.__randyHandshakeJobCache).length,
        pageSearch: window.__randyHandshakeJobPage,
      };
    };
    console.log(BRIDGE_TAG + " run __randyHandshakeBridgeCheck() / __randyHandshakeJobs() / getCurrentHandshakeJob() in console to verify cache");
  } catch (_e) {}
})();

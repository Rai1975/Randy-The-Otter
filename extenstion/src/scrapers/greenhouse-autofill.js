/* Greenhouse application autofill — native inputs only; never submits.
 * Verified against the current Greenhouse-hosted DOM: standard fields use
 * ids/names `first_name`, `last_name`, `email`, and `phone`.
 */

const RANDY_PROFILE_URL = "http://127.0.0.1:5000/profile";
const GREENHOUSE_FIELD_KEYWORDS = {
  first_name: ["first_name", "fname"],
  last_name: ["last_name", "lname"],
  email: ["email"],
  phone: ["phone"],
  address: ["address", "location"],
};
const GREENHOUSE_PROFILE_FIELDS = {
  first_name: "first_name",
  last_name: "last_name",
  email: "email",
  phone: "phone_number",
  address: "address",
};

// Human-pacing config (Option A): small random delays to avoid
// Greenhouse "Submission Velocity" flag (30+ fields <500ms = Scripted).
// Total for 4-5 native fields: ~1100-3100ms (300-800 initial + per-field
// 80-180 pre-focus + 120-280 inter-field). Keeps isTrusted=false
// but gives variable inter-field timing and focus/blur events.
const GREENHOUSE_AUTOFILL_INITIAL_DELAY_MIN_MS = 300;
const GREENHOUSE_AUTOFILL_INITIAL_DELAY_MAX_MS = 800;
const GREENHOUSE_AUTOFILL_FIELD_DELAY_MIN_MS = 120;
const GREENHOUSE_AUTOFILL_FIELD_DELAY_MAX_MS = 280;
const GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MIN_MS = 80;
const GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MAX_MS = 180;

function getGreenhouseApplicationIdentity() {
  const match = window.location.pathname.match(/^\/([^/]+)\/jobs\/([^/?#]+)/);
  if (!match || !/^(job-boards|boards)\.greenhouse\.io$/i.test(window.location.hostname)) {
    return null;
  }
  return { board_token: match[1], job_id: match[2] };
}

function normalizedGreenhouseText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function fieldKeyFromText(text) {
  const normalized = normalizedGreenhouseText(text);
  const matches = Object.entries(GREENHOUSE_FIELD_KEYWORDS)
    .filter(([, words]) => words.some((word) => normalized.includes(word)));
  return matches.length === 1 ? matches[0][0] : null;
}

function getGreenhouseFieldLabel(el) {
  const parts = [];
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) parts.push(label.innerText || label.textContent);
  }
  parts.push(el.getAttribute("aria-label"));
  const parentLabel = el.closest("label");
  if (parentLabel) parts.push(parentLabel.innerText || parentLabel.textContent);
  return parts.filter(Boolean).join(" ");
}

function getGreenhouseFieldKey(el) {
  return fieldKeyFromText(`${el.id || ""} ${el.name || ""}`) ||
    fieldKeyFromText(getGreenhouseFieldLabel(el));
}

function isGreenhouseVisibleField(el) {
  // Skip honeypots / offscreen decoys: invisible to humans but in DOM.
  // Real Greenhouse native fields are always rendered and visible.
  try {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    if (el.getClientRects().length === 0) return false;
    // Offscreen honeypot (left:-9999px etc.) — also 0 rects, but keep explicit check
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
  } catch (_) {
    // If style check fails, fall back to basic visibility
  }
  return true;
}

function findGreenhouseCandidateFields() {
  return [...document.querySelectorAll("input, textarea")]
    .filter((el) => !el.disabled && el.type !== "hidden" && isGreenhouseVisibleField(el))
    .map((el) => ({ el, key: getGreenhouseFieldKey(el) }))
    .filter((candidate) => candidate.key);
}

function isGreenhouseApplicationPage() {
  return Boolean(getGreenhouseApplicationIdentity()) &&
    (findGreenhouseCandidateFields().length > 0 || /\/jobs\//.test(window.location.pathname));
}

function waitForGreenhouseForm(timeoutMs = 8000) {
  if (findGreenhouseCandidateFields().length) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (findGreenhouseCandidateFields().length) finish(true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function greenhouseSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function greenhouseRandInt(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function setReactControlledValue(el, value) {
  const prototype = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  // Human-like focus/blur sequence: many ATS validators listen for focus
  // before input and blur after change. Adds realistic event spread.
  try {
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  } catch (_) {}
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    // Keep blur without stealing focus permanently - next field will refocus
    if (typeof el.blur === "function") el.blur();
  } catch (_) {}
}

function fetchGreenhouseProfileViaBackground() {
  return new Promise((resolve) => {
    try {
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        !chrome.runtime.id ||
        !chrome.runtime.sendMessage
      ) {
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage({ type: "get-profile" }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn("[Randy] Greenhouse profile background error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (!resp) {
          resolve(null);
          return;
        }
        if (resp.ok && resp.profile) {
          resolve(resp.profile);
        } else {
          console.warn("[Randy] Greenhouse profile background failed:", resp.error || resp);
          resolve(null);
        }
      });
    } catch (e) {
      console.warn("[Randy] Greenhouse profile background exception:", e);
      resolve(null);
    }
  });
}

async function getGreenhouseProfile() {
  const sessionId = typeof getRandySessionId === "function" ? getRandySessionId() : "default";
  const cached = window.__randyGreenhouseProfile;
  if (cached && cached.sessionId === sessionId) return cached.profile;

  // Preferred: background fetch (privileged, bypasses Greenhouse CSP connect-src
  // and Private Network Access blocking of http://127.0.0.1 from https).
  let profile = await fetchGreenhouseProfileViaBackground();
  if (profile) {
    window.__randyGreenhouseProfile = { sessionId, profile };
    return profile;
  }

  // Fallback: direct fetch (covers orphaned SW or background not yet awake;
  // may still be blocked by CSP/PNA on some Greenhouse pages).
  try {
    const response = await fetch(RANDY_PROFILE_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`profile responded ${response.status}`);
    profile = await response.json();
    window.__randyGreenhouseProfile = { sessionId, profile };
    return profile;
  } catch (error) {
    console.warn("[Randy] Greenhouse profile fetch failed (is server.py running on 127.0.0.1:5000?):", error);
    return null;
  }
}

async function autofillGreenhouseApplication() {
  const identity = getGreenhouseApplicationIdentity();
  if (!identity) return [];
  const applicationKey = `${identity.board_token}:${identity.job_id}`;
  if (window.__randyGreenhouseFilledKey === applicationKey) return [];
  if (!(await waitForGreenhouseForm()) || window.__randyGreenhouseFilledKey === applicationKey) return [];
  const profile = await getGreenhouseProfile();
  if (!profile) return [];

  // Initial random delay before first field — avoids immediate fill on navigation
  // which is a classic bot signature (e.g. Greenhouse velocity sensor).
  await greenhouseSleep(
    greenhouseRandInt(GREENHOUSE_AUTOFILL_INITIAL_DELAY_MIN_MS, GREENHOUSE_AUTOFILL_INITIAL_DELAY_MAX_MS)
  );
  // Re-check dedupe after the pause — another tab/trigger may have filled
  if (window.__randyGreenhouseFilledKey === applicationKey) return [];

  const filled = [];
  const usedKeys = new Set();
  for (const { el, key } of findGreenhouseCandidateFields()) {
    if (usedKeys.has(key)) continue;
    // Skip if field was removed / hidden during the paced run (SPA re-render)
    if (!document.contains(el) || !isGreenhouseVisibleField(el)) continue;
    const value = profile[GREENHOUSE_PROFILE_FIELDS[key]];
    if (typeof value !== "string" || !value.trim()) continue;
    if (el.value !== value) {
      // Small pre-focus pause to mimic human moving between fields
      await greenhouseSleep(
        greenhouseRandInt(
          GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MIN_MS,
          GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MAX_MS
        )
      );
      setReactControlledValue(el, value);
      filled.push(key);
      // Inter-field jitter — sequential fill, not burst. Total for 4-5 fields ~600-1200ms.
      await greenhouseSleep(
        greenhouseRandInt(GREENHOUSE_AUTOFILL_FIELD_DELAY_MIN_MS, GREENHOUSE_AUTOFILL_FIELD_DELAY_MAX_MS)
      );
    }
    usedKeys.add(key);
  }

  window.__randyGreenhouseFilledKey = applicationKey;
  console.log("[Randy] Greenhouse autofill:", { ...identity, filled_fields: filled });
  if (filled.length && typeof sendRandyEvent === "function") {
    sendRandyEvent("greenhouse-autofill", { ...identity, filled_fields: filled })
      .then((data) => {
        if (typeof setBubbleFromBackend === "function") setBubbleFromBackend(data);
      })
      .catch((error) => console.warn("[Randy] Greenhouse autofill event failed:", error));
  }
  return filled;
}

function debugGreenhouseAutofill() {
  const report = {
    url: window.location.href,
    identity: getGreenhouseApplicationIdentity(),
    isApplicationPage: isGreenhouseApplicationPage(),
    filledKey: window.__randyGreenhouseFilledKey || null,
    fields: findGreenhouseCandidateFields().map(({ el, key }) => ({
      key, id: el.id || null, name: el.name || null, label: getGreenhouseFieldLabel(el) || null,
    })),
  };
  console.log("[Randy] Greenhouse autofill debug:", report);
  return report;
}

window.__randyGreenhouseDebug = debugGreenhouseAutofill;

(function startGreenhouseAutofillWatcher() {
  let lastHref = null;
  let inFlight = false;
  const check = () => {
    if (window.location.href === lastHref) return;
    lastHref = window.location.href;
    if (isGreenhouseApplicationPage()) {
      if (inFlight) return;
      inFlight = true;
      autofillGreenhouseApplication()
        .catch((error) => console.warn("[Randy] Greenhouse autofill failed:", error))
        .finally(() => {
          inFlight = false;
        });
    }
  };
  check();
  window.setInterval(check, 1000);
})();

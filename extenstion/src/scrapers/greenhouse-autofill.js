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

function findGreenhouseCandidateFields() {
  return [...document.querySelectorAll("input, textarea")]
    .filter((el) => !el.disabled && el.type !== "hidden")
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

function setReactControlledValue(el, value) {
  const prototype = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function getGreenhouseProfile() {
  const sessionId = typeof getRandySessionId === "function" ? getRandySessionId() : "default";
  const cached = window.__randyGreenhouseProfile;
  if (cached && cached.sessionId === sessionId) return cached.profile;
  try {
    const response = await fetch(RANDY_PROFILE_URL);
    if (!response.ok) throw new Error(`profile responded ${response.status}`);
    const profile = await response.json();
    window.__randyGreenhouseProfile = { sessionId, profile };
    return profile;
  } catch (error) {
    console.warn("[Randy] Greenhouse profile fetch failed:", error);
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

  const filled = [];
  const usedKeys = new Set();
  for (const { el, key } of findGreenhouseCandidateFields()) {
    if (usedKeys.has(key)) continue;
    const value = profile[GREENHOUSE_PROFILE_FIELDS[key]];
    if (typeof value !== "string" || !value.trim()) continue;
    if (el.value !== value) {
      setReactControlledValue(el, value);
      filled.push(key);
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
  const check = () => {
    if (window.location.href === lastHref) return;
    lastHref = window.location.href;
    if (isGreenhouseApplicationPage()) {
      autofillGreenhouseApplication().catch((error) =>
        console.warn("[Randy] Greenhouse autofill failed:", error)
      );
    }
  };
  check();
  window.setInterval(check, 1000);
})();

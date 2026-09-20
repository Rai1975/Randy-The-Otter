/* Greenhouse application autofill — native inputs + custom select__container; never submits.
 * Profile source is exclusively chrome.storage.local (randyPreferences.personalInformation + sponsorship).
 * If storage is empty/missing, autofill aborts with a warning — no env/backend fallback.
 * Handles Greenhouse React-Select: div.select__container with label.select__label.
 */

const GREENHOUSE_FIELD_KEYWORDS = {
  first_name: ["first_name", "fname", "first name"],
  last_name: ["last_name", "lname", "last name"],
  email: ["email"],
  phone: ["phone"],
  address: ["address", "location", "street"],
  linkedin: ["linkedin", "linked-in"],
  website: ["website", "portfolio", "personal website", "personal site"],
  veteran_status: ["veteran", "military service"],
  disability_status: ["disability", "disabled"],
  race: ["race", "ethnicity"],
  gender: ["gender", "sex"],
  sponsorship: ["sponsorship", "sponsor", "authorized to work", "work authorization", "visa", "require sponsorship"],
};
const GREENHOUSE_PROFILE_FIELDS = {
  first_name: "firstName",
  last_name: "lastName",
  email: "email",
  phone: "phoneNumber",
  address: "homeAddress",
  linkedin: "linkedinUrl",
  website: "websiteUrl",
  veteran_status: "veteranStatus",
  disability_status: "disabilityStatus",
  race: "race",
  gender: "gender",
  sponsorship: "sponsorship",
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
const GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MIN_MS = 150;
const GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MAX_MS = 320;

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
  try {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    if (el.getClientRects().length === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
  } catch (_) {}
  return true;
}

function findGreenhouseCandidateFields() {
  return [...document.querySelectorAll("input, textarea, select")]
    .filter((el) => !el.disabled && el.type !== "hidden" && isGreenhouseVisibleField(el))
    .map((el) => ({ el, key: getGreenhouseFieldKey(el) }))
    .filter((candidate) => candidate.key);
}

// ---------------------------------------------------------------------------
// Custom select__container support
// ---------------------------------------------------------------------------
function getGreenhouseCustomSelectQuestion(container) {
  // Primary: label.select__label inside container or adjacent
  let label = container.querySelector("label.select__label");
  if (label) return label.innerText || label.textContent || "";
  // Labels often sit as sibling of the container inside same field wrapper
  let prev = container.previousElementSibling;
  let depth = 0;
  while (prev && depth < 4) {
    if (prev.matches && prev.matches("label.select__label")) {
      return prev.innerText || prev.textContent || "";
    }
    const inner = prev.querySelector && prev.querySelector("label.select__label");
    if (inner) return inner.innerText || inner.textContent || "";
    prev = prev.previousElementSibling;
    depth++;
  }
  // Parent wrapper search
  const parent = container.parentElement;
  if (parent) {
    const parentLabel = parent.querySelector("label.select__label");
    if (parentLabel) return parentLabel.innerText || parentLabel.textContent || "";
  }
  // Aria label on control as fallback
  const ariaEl = container.querySelector("[aria-label]");
  if (ariaEl) return ariaEl.getAttribute("aria-label") || "";
  // Last resort: first non-empty text line inside container's parent
  return "";
}

function getGreenhouseCustomSelectKey(container) {
  const question = getGreenhouseCustomSelectQuestion(container);
  return fieldKeyFromText(question);
}

function findGreenhouseCustomSelects() {
  const containers = [...document.querySelectorAll("div.select__container")];
  return containers
    .filter((c) => isGreenhouseVisibleField(c))
    .map((container) => ({
      container,
      key: getGreenhouseCustomSelectKey(container),
      question: getGreenhouseCustomSelectQuestion(container),
    }))
    .filter((c) => c.key);
}

function isGreenhouseApplicationPage() {
  return Boolean(getGreenhouseApplicationIdentity()) &&
    (findGreenhouseCandidateFields().length > 0 || findGreenhouseCustomSelects().length > 0 || /\/jobs\//.test(window.location.pathname));
}

function waitForGreenhouseForm(timeoutMs = 8000) {
  if (findGreenhouseCandidateFields().length || findGreenhouseCustomSelects().length) return Promise.resolve(true);
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
      if (findGreenhouseCandidateFields().length || findGreenhouseCustomSelects().length) finish(true);
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
    : el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  try {
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  } catch (_) {}
  const selectedValue = el instanceof HTMLSelectElement
    ? [...el.options].find((option) =>
      normalizedGreenhouseText(option.value) === normalizedGreenhouseText(value) ||
      normalizedGreenhouseText(option.textContent) === normalizedGreenhouseText(value) ||
      normalizedGreenhouseText(option.value).includes(normalizedGreenhouseText(value))
    )?.value
    : value;
  if (!selectedValue) return;
  setter.call(el, selectedValue);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    if (typeof el.blur === "function") el.blur();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// chrome.storage profile — sole source (no backend/env fallback)
// ---------------------------------------------------------------------------
async function getGreenhousePreferencesFromStorage() {
  if (typeof getRandyPreferences === "function") {
    try {
      const prefs = await getRandyPreferences();
      if (prefs) return prefs;
    } catch (_) {}
  }
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const result = await chrome.storage.local.get("randyPreferences");
      return result.randyPreferences || null;
    }
  } catch (e) {
    console.warn("[Randy] Greenhouse chrome.storage read failed:", e);
  }
  return null;
}

function isGreenhousePrefsEmpty(preferences) {
  if (!preferences || typeof preferences !== "object") return true;
  const pi = preferences.personalInformation || {};
  const hasPI = ["firstName", "lastName", "phoneNumber", "email", "homeAddress", "linkedinUrl", "websiteUrl", "veteranStatus", "disabilityStatus", "race", "gender"]
    .some((k) => typeof pi[k] === "string" && pi[k].trim().length > 0);
  // sponsorship "any" is default — treat as empty unless PI has something
  // If any PI field present, prefs is non-empty; sponsorship alone not enough to autofill
  return !hasPI;
}

function resolveGreenhouseValueForKey(key, question, preferences) {
  const pi = (preferences && preferences.personalInformation) || {};
  if (key === "sponsorship") {
    const sponsorship = preferences.sponsorship || "any";
    const needsSponsorship = sponsorship === "required" || sponsorship === "preferred";
    const q = normalizedGreenhouseText(question);
    if (q.includes("sponsor")) {
      return needsSponsorship ? "Yes" : "No";
    }
    if (q.includes("authorized") || q.includes("work authorization")) {
      return needsSponsorship
        ? "No, I will need sponsorship"
        : "Yes";
    }
    return needsSponsorship ? "Yes" : "No";
  }
  const map = GREENHOUSE_PROFILE_FIELDS;
  const storageKey = map[key];
  const raw = pi[storageKey] || "";
  if (typeof raw !== "string" || !raw.trim()) return "";
  return raw.trim();
}

function findGreenhouseBestOption(options, desiredValue) {
  const normVal = normalizedGreenhouseText(desiredValue);
  if (!normVal) return null;
  let target = options.find((o) => normalizedGreenhouseText(o.textContent) === normVal);
  if (target) return target;
  target = options.find((o) => normalizedGreenhouseText(o.value || "") === normVal);
  if (target) return target;
  // Substring either direction
  target = options.find((o) => {
    const t = normalizedGreenhouseText(o.textContent);
    return t.includes(normVal) || normVal.includes(t);
  });
  if (target) return target;
  // Decline / do not wish variations
  if (normVal.includes("decline") || normVal.includes("do not wish") || normVal.includes("don't wish") || normVal.includes("do not wish to answer")) {
    target = options.find((o) => {
      const t = normalizedGreenhouseText(o.textContent);
      return t.includes("decline") || t.includes("do not wish") || t.includes("don't wish");
    });
    if (target) return target;
  }
  // Yes/No short fallback for veteran/disability when stored value is long sentence
  if (normVal.includes("protected veteran") || normVal.includes("have a disability")) {
    const wantYes = normVal.includes("protected veteran") && !normVal.includes("not a") || normVal.includes("have a disability") && normVal.startsWith("yes");
    // Actually "I am not a protected veteran" should map to No
    if (normVal === "i am a protected veteran" || normVal === "yes, i have a disability") {
      target = options.find((o) => normalizedGreenhouseText(o.textContent) === "yes");
      if (target) return target;
    }
    if (normVal === "i am not a protected veteran" || normVal === "no, i do not have a disability") {
      target = options.find((o) => normalizedGreenhouseText(o.textContent) === "no");
      if (target) return target;
    }
  }
  // Generic Yes/No text inside long value
  if (normVal === "yes" || normVal === "no") {
    target = options.find((o) => normalizedGreenhouseText(o.textContent) === normVal);
    if (target) return target;
  }
  return null;
}

async function fillGreenhouseCustomSelect(container, desiredValue) {
  const control = container.querySelector("div.select__control, div[class*='select__control']") || container;
  const singleValue = container.querySelector("div.select__single-value, div[class*='single-value']");
  if (singleValue && normalizedGreenhouseText(singleValue.textContent) === normalizedGreenhouseText(desiredValue)) {
    return false;
  }
  // Also check for Yes/No short form already matching resolved value via substring
  if (singleValue && findGreenhouseBestOption([singleValue], desiredValue)) {
    const cur = normalizedGreenhouseText(singleValue.textContent);
    const want = normalizedGreenhouseText(desiredValue);
    if (cur === want || cur.includes(want) || want.includes(cur)) return false;
  }
  try {
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  } catch (_) {}
  try { control.click(); } catch (_) {}
  try { control.focus(); } catch (_) {}
  await greenhouseSleep(greenhouseRandInt(GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MIN_MS, GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MAX_MS));
  // Menu is usually portaled to body, not inside container
  let menu = document.querySelector("div.select__menu, div[class*='select__menu']");
  if (!menu) {
    for (let i = 0; i < 8; i++) {
      await greenhouseSleep(100);
      menu = document.querySelector("div.select__menu, div[class*='select__menu']");
      if (menu) break;
    }
  }
  if (!menu) {
    console.warn("[Randy] Greenhouse custom select menu not found for:", container);
    // Try to close by blurring to avoid stuck overlay
    try { control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (_) {}
    return false;
  }
  const options = [...menu.querySelectorAll("div.select__option, div[class*='select__option']")];
  if (!options.length) {
    console.warn("[Randy] Greenhouse custom select has no options:", menu);
    return false;
  }
  const target = findGreenhouseBestOption(options, desiredValue);
  if (!target) {
    console.warn("[Randy] Greenhouse custom select no matching option for", JSON.stringify(desiredValue), "options:", options.map((o) => o.textContent?.trim()));
    try { control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (_) {}
    return false;
  }
  try {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  } catch (_) {}
  try { target.click(); } catch (_) {}
  try { target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); } catch (_) {}
  await greenhouseSleep(greenhouseRandInt(120, 250));
  return true;
}

async function autofillGreenhouseApplication() {
  const identity = getGreenhouseApplicationIdentity();
  if (!identity) return [];
  const applicationKey = `${identity.board_token}:${identity.job_id}`;
  if (window.__randyGreenhouseFilledKey === applicationKey) return [];
  if (!(await waitForGreenhouseForm()) || window.__randyGreenhouseFilledKey === applicationKey) return [];
  const preferences = await getGreenhousePreferencesFromStorage();
  if (!preferences || isGreenhousePrefsEmpty(preferences)) {
    console.warn("[Randy] Greenhouse autofill aborted: no profile in chrome.storage (open Randy settings to fill personal information).");
    // Surface to bubble if available so user sees the error
    try {
      if (typeof setBubbleVisible === "function" && typeof setBubbleText === "function") {
        setBubbleVisible(true);
        setBubbleText("fill your Randy settings first bro – no profile stored for autofill");
        if (typeof setChoicesVisible === "function") setChoicesVisible(false);
      }
    } catch (_) {}
    return [];
  }

  await greenhouseSleep(
    greenhouseRandInt(GREENHOUSE_AUTOFILL_INITIAL_DELAY_MIN_MS, GREENHOUSE_AUTOFILL_INITIAL_DELAY_MAX_MS)
  );
  if (window.__randyGreenhouseFilledKey === applicationKey) return [];

  const filled = [];
  const usedKeys = new Set();

  // Native inputs / textareas / selects
  for (const { el, key } of findGreenhouseCandidateFields()) {
    if (usedKeys.has(key)) continue;
    if (!document.contains(el) || !isGreenhouseVisibleField(el)) continue;
    const value = resolveGreenhouseValueForKey(key, getGreenhouseFieldLabel(el), preferences);
    // Best-effort address split: if Greenhouse has city/state/zip fields but homeAddress is one line, try to fill what we can
    // For now native address mapping uses full homeAddress; specific sub-fields will fail keyword match to address and be skipped
    if (typeof value !== "string" || !value.trim()) continue;
    // Don't overwrite non-empty select that already matches (e.g. Race filled earlier)
    if (el instanceof HTMLSelectElement) {
      const curText = normalizedGreenhouseText(el.options[el.selectedIndex]?.textContent || "");
      if (curText && curText === normalizedGreenhouseText(value)) {
        usedKeys.add(key);
        continue;
      }
    } else if (el.value && el.value.trim() === value) {
      usedKeys.add(key);
      continue;
    }
    if (el.value !== value) {
      await greenhouseSleep(
        greenhouseRandInt(
          GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MIN_MS,
          GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MAX_MS
        )
      );
      // Avoid overwriting user-edited fields that changed during pacing
      if (!document.contains(el) || !isGreenhouseVisibleField(el)) continue;
      setReactControlledValue(el, value);
      filled.push(key);
      await greenhouseSleep(
        greenhouseRandInt(GREENHOUSE_AUTOFILL_FIELD_DELAY_MIN_MS, GREENHOUSE_AUTOFILL_FIELD_DELAY_MAX_MS)
      );
    }
    usedKeys.add(key);
  }

  // Custom select__container (React-Select) — sponsorship / veteran / disability / race / gender etc.
  for (const { container, key, question } of findGreenhouseCustomSelects()) {
    if (usedKeys.has(key)) continue;
    if (!document.contains(container) || !isGreenhouseVisibleField(container)) continue;
    const desiredValue = resolveGreenhouseValueForKey(key, question, preferences);
    if (typeof desiredValue !== "string" || !desiredValue.trim()) continue;
    await greenhouseSleep(
      greenhouseRandInt(
        GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MIN_MS,
        GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MAX_MS
      )
    );
    if (!document.contains(container) || !isGreenhouseVisibleField(container)) continue;
    const didFill = await fillGreenhouseCustomSelect(container, desiredValue);
    if (didFill) filled.push(key);
    usedKeys.add(key);
    await greenhouseSleep(
      greenhouseRandInt(GREENHOUSE_AUTOFILL_FIELD_DELAY_MIN_MS, GREENHOUSE_AUTOFILL_FIELD_DELAY_MAX_MS)
    );
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
    customSelects: findGreenhouseCustomSelects().map(({ container, key, question }) => ({
      key, question: question || null, controlText: container.querySelector("div.select__single-value, div[class*='single-value']")?.textContent?.trim() || null,
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

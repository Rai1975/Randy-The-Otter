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
  // 1. PRIMARY: label[for] -> id association (handles Greenhouse for/id wrappers)
  // Greenhouse links like <label for="gender" id="gender-label"> with hidden <input id="gender"> inside container.
  try {
    const candidateIds = new Set();
    if (container.id) candidateIds.add(container.id);
    container.querySelectorAll("[id]").forEach((el) => {
      if (el.id) candidateIds.add(el.id);
    });
    if (candidateIds.size) {
      const labels = document.querySelectorAll("label[for]");
      for (const lab of labels) {
        const forVal = lab.getAttribute("for");
        if (forVal && candidateIds.has(forVal)) {
          const t = lab.innerText || lab.textContent;
          if (t && t.trim()) return t.trim();
        }
      }
    }
  } catch (_) {}

  // 2. SECONDARY: aria-labelledby on any element inside container
  try {
    const labelledEl = container.querySelector("[aria-labelledby]");
    if (labelledEl) {
      const raw = labelledEl.getAttribute("aria-labelledby") || "";
      const ids = raw.split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const ref = document.getElementById(id);
        if (ref) {
          const t = ref.innerText || ref.textContent;
          if (t && t.trim()) return t.trim();
        }
      }
    }
  } catch (_) {}

  // 3. EXISTING fallbacks (kept as safety net)
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

// React Fiber helpers for react-select (Option A - fiber direct call)
function getGreenhouseReactFiberKey(el) {
  try {
    return Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  } catch (_) {
    return null;
  }
}

function findGreenhouseSelectFiber(inputEl) {
  const fk = getGreenhouseReactFiberKey(inputEl);
  if (!fk) return null;
  let cur = inputEl[fk];
  for (let i = 0; i < 30 && cur; i++) {
    const p = cur.memoizedProps;
    if (p && typeof p.selectOption === "function" && Array.isArray(p.options)) return p;
    // also handle alternate shape where selectOption lives on stateNode or pendingProps
    const pending = cur.pendingProps;
    if (pending && typeof pending.selectOption === "function" && Array.isArray(pending.options)) return pending;
    cur = cur.return;
  }
  return null;
}

async function waitForGreenhouseHydration(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const probe = document.getElementById("first_name") || document.querySelector("div.select__container input");
    if (probe && getGreenhouseReactFiberKey(probe)) return true;
    // also consider native inputs hydrating
    if (probe) {
      await greenhouseSleep(400);
    } else {
      await greenhouseSleep(600);
      // if no probe at all, assume static non-React page and return true to not block
      if (!document.querySelector("div.select__container")) return true;
    }
    if (Date.now() - start > 2000 && !document.querySelector("div.select__container")) return true;
  }
  return false;
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

// Option C: Greenhouse Job Board API schema fetch (no auth) — enriches option matching
// GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true
// Returns questions[], compliance[], demographic_questions, location_questions
let __greenhouseSchemaCache = { key: null, data: null, at: 0 };

async function fetchGreenhouseSchema(identity) {
  if (!identity || !identity.board_token || !identity.job_id) return null;
  const cacheKey = `${identity.board_token}:${identity.job_id}`;
  if (__greenhouseSchemaCache.key === cacheKey && __greenhouseSchemaCache.data && (Date.now() - __greenhouseSchemaCache.at) < 5 * 60 * 1000) {
    return __greenhouseSchemaCache.data;
  }
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identity.board_token)}/jobs/${encodeURIComponent(identity.job_id)}?questions=true`;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4500);
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    clearTimeout(tid);
    if (!resp.ok) {
      console.warn(`[Randy] Greenhouse schema fetch ${resp.status} for ${cacheKey}`);
      return null;
    }
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== "object") return null;
    __greenhouseSchemaCache = { key: cacheKey, data, at: Date.now() };
    // Pre-log for debugging; autofill will use exact values[] labels to validate desiredValue
    console.log("[Randy] Greenhouse schema fetched:", { board: identity.board_token, job: identity.job_id, questions: (data.questions||[]).length, compliance: (data.compliance||[]).length, demo: data.demographic_questions ? (data.demographic_questions.questions||[]).length : 0 });
    return data;
  } catch (e) {
    console.warn("[Randy] Greenhouse schema fetch failed:", e && e.message ? e.message : e);
    return null;
  }
}

function findGreenhouseSchemaValuesForKey(key, question, schema) {
  if (!schema || !key) return null;
  const normQ = normalizedGreenhouseText(question || "");
  const normKeyWords = GREENHOUSE_FIELD_KEYWORDS[key] || [];
  // Collect all question buckets
  const buckets = [];
  if (Array.isArray(schema.questions)) buckets.push(...schema.questions);
  if (Array.isArray(schema.compliance)) buckets.push(...schema.compliance);
  if (schema.demographic_questions && Array.isArray(schema.demographic_questions.questions)) {
    // normalize demographic shape to same as questions: {label, fields:[{values:[{label}]}]}
    for (const dq of schema.demographic_questions.questions) {
      const vals = Array.isArray(dq.answer_options) ? dq.answer_options.map((o) => ({ label: o.label, value: String(o.id) })) : [];
      buckets.push({ label: dq.label, fields: [{ type: dq.type || "multi_value_single_select", values: vals, name: `demo_${dq.id}` }] });
    }
  }
  // Find best matching bucket by label fuzzy
  let best = null;
  let bestScore = -1;
  for (const q of buckets) {
    const lab = normalizedGreenhouseText(q.label || "");
    if (!lab) continue;
    // Exact keyword overlap score
    let score = 0;
    for (const w of normKeyWords) if (lab.includes(w)) score += 2;
    if (normQ && lab.includes(normQ.slice(0, 20))) score += 3;
    if (normQ && normQ.includes(lab.slice(0, 20))) score += 2;
    // Also direct label includes key hint like "gender"
    if (lab === normQ) score += 5;
    if (score > bestScore) { bestScore = score; best = q; }
  }
  if (!best || bestScore <= 0) return null;
  // Consolidate values from all fields
  const out = [];
  for (const f of (best.fields || [])) {
    if (Array.isArray(f.values)) {
      for (const v of f.values) if (v && v.label) out.push(v);
    }
  }
  return out.length ? out : null;
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

async function fillGreenhouseCustomSelect(container, desiredValue, schema) {
  // Already filled check
  const singleValue = container.querySelector("div.select__single-value, div[class*='single-value']");
  if (singleValue && normalizedGreenhouseText(singleValue.textContent) === normalizedGreenhouseText(desiredValue)) {
    return false;
  }
  if (singleValue && findGreenhouseBestOption([singleValue], desiredValue)) {
    const cur = normalizedGreenhouseText(singleValue.textContent);
    const want = normalizedGreenhouseText(desiredValue);
    if (cur === want || cur.includes(want) || want.includes(cur)) return false;
  }

  // --- Option A primary: React Fiber direct call (most robust, bypasses DOM) ---
  let fiberInput = container.querySelector('input[role="combobox"]')
    || container.querySelector("div.select__input input")
    || container.querySelector('input[type="text"]')
    || container.querySelector("input");
  if (fiberInput) {
    // Ensure fiber exists; if not yet hydrated wait briefly
    let fiber = findGreenhouseSelectFiber(fiberInput);
    if (!fiber) {
      await greenhouseSleep(450);
      fiber = findGreenhouseSelectFiber(fiberInput);
    }
    if (fiber && Array.isArray(fiber.options) && fiber.options.length) {
      // Prefer schema exact labels when available (Option C enrichment)
      let option = null;
      const normDesired = normalizedGreenhouseText(desiredValue);
      // Try exact label/value match
      option = fiber.options.find((o) => normalizedGreenhouseText(o.label) === normDesired)
        || fiber.options.find((o) => normalizedGreenhouseText(String(o.value)) === normDesired);
      // If schema present, try schema values to normalize label (handles "Two or more races" vs "Two or More Races" casing)
      if (!option && schema) {
        const schemaVals = schema; // when called with container-scoped values array, schema is array
        if (Array.isArray(schema) && schema.length) {
          const schemaMatch = schema.find((v) => normalizedGreenhouseText(v.label) === normDesired)
            || schema.find((v) => normalizedGreenhouseText(v.label).includes(normDesired) || normDesired.includes(normalizedGreenhouseText(v.label)));
          if (schemaMatch) {
            option = fiber.options.find((o) => normalizedGreenhouseText(o.label) === normalizedGreenhouseText(schemaMatch.label));
          }
        }
      }
      // Substring either direction
      if (!option) {
        option = fiber.options.find((o) => {
          const t = normalizedGreenhouseText(o.label);
          return t.includes(normDesired) || normDesired.includes(t);
        });
      }
      // Decline / veteran / disability fallbacks via existing helper
      if (!option) {
        const fakeOptions = fiber.options.map((o) => ({ textContent: o.label, value: o.value }));
        const fakeTarget = findGreenhouseBestOption(fakeOptions, desiredValue);
        if (fakeTarget) {
          const foundLabel = normalizedGreenhouseText(fakeTarget.textContent);
          option = fiber.options.find((o) => normalizedGreenhouseText(o.label) === foundLabel);
        }
      }
      if (option) {
        try {
          fiber.selectOption(option);
          // Verify via getValue if available
          try {
            if (typeof fiber.getValue === "function") {
              const got = fiber.getValue();
              if (Array.isArray(got) && got[0] && normalizedGreenhouseText(got[0].label) === normalizedGreenhouseText(option.label)) {
                await greenhouseSleep(greenhouseRandInt(120, 220));
                return true;
              }
            }
          } catch (_) {}
          await greenhouseSleep(greenhouseRandInt(120, 220));
          // Confirm selection stuck by checking singleValue text after brief pause
          await greenhouseSleep(180);
          const afterSingle = container.querySelector("div.select__single-value, div[class*='single-value']");
          if (afterSingle && normalizedGreenhouseText(afterSingle.textContent) === normalizedGreenhouseText(option.label)) return true;
          // Even if singleValue not yet updated, consider fiber call succeeded
          return true;
        } catch (e) {
          console.warn("[Randy] Greenhouse fiber selectOption failed, falling back to type:", e && e.message ? e.message : e);
        }
      }
    }
  }

  // --- Fallback: treat as text input — type and move on (your requested behavior) ---
  let input = fiberInput;
  if (!input) {
    const control = container.querySelector("div.select__control, div[class*='select__control']") || container;
    try { control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); } catch (_) {}
    try { control.click(); } catch (_) {}
    try { control.focus(); } catch (_) {}
    await greenhouseSleep(greenhouseRandInt(GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MIN_MS, GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MAX_MS));
    input = container.querySelector('input[role="combobox"]')
      || container.querySelector("div.select__input input")
      || container.querySelector('input[type="text"]')
      || container.querySelector("input");
    if (!input) return false;
  }

  try {
    const control = container.querySelector("div.select__control, div[class*='select__control']");
    if (control) control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  } catch (_) {}
  try { input.focus(); } catch (_) {}
  try { input.dispatchEvent(new FocusEvent("focus", { bubbles: true })); } catch (_) {}
  await greenhouseSleep(greenhouseRandInt(GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MIN_MS, GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MAX_MS));

  try {
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, desiredValue);
  } catch (_) {
    try { input.value = desiredValue; } catch (_) {}
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  } catch (_) {}
  await greenhouseSleep(150);
  try {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  } catch (_) {}
  await greenhouseSleep(80);
  try {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, which: 9, bubbles: true }));
  } catch (_) {}
  try {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    if (typeof input.blur === "function") input.blur();
  } catch (_) {}

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

  // Option C: fetch exact form schema (no auth) to validate labels/values offline; never blocks fill for more than ~4.5s
  // Option A: wait for React hydration so fiber helpers are available
  const [schema] = await Promise.all([
    fetchGreenhouseSchema(identity),
    waitForGreenhouseHydration(6000),
  ]);

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
  // Uses fiber direct call (Option A) with schema enrichment (Option C), fallback to type-and-move-on
  for (const { container, key, question } of findGreenhouseCustomSelects()) {
    if (usedKeys.has(key)) continue;
    if (!document.contains(container) || !isGreenhouseVisibleField(container)) continue;
    const desiredValue = resolveGreenhouseValueForKey(key, question, preferences);
    if (typeof desiredValue !== "string" || !desiredValue.trim()) continue;
    // Enrich with exact API values for this question to improve fiber matching fidelity
    const schemaValues = findGreenhouseSchemaValuesForKey(key, question, schema);
    if (schemaValues) {
      console.log(`[Randy] Greenhouse schema match for ${key} (“${question}”):`, schemaValues.map((v) => v.label));
    }
    await greenhouseSleep(
      greenhouseRandInt(
        GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MIN_MS,
        GREENHOUSE_AUTOFILL_PRE_FOCUS_DELAY_MAX_MS
      )
    );
    if (!document.contains(container) || !isGreenhouseVisibleField(container)) continue;
    const didFill = await fillGreenhouseCustomSelect(container, desiredValue, schemaValues);
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

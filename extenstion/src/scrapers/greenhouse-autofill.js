/* Greenhouse application autofill — native inputs + custom select__container; never submits.
 * Profile source is exclusively chrome.storage.local (randyPreferences.personalInformation + sponsorship).
 * If storage is empty/missing, autofill aborts with a warning — no env/backend fallback.
 * Handles Greenhouse React-Select: div.select__container with label.select__label.
 */

const GREENHOUSE_FIELD_KEYWORDS = {
  country: ["country", "country code", "phone country"],
  first_name: ["first_name", "fname", "first name"],
  last_name: ["last_name", "lname", "last name"],
  email: ["email"],
  phone: ["phone"],
  address: ["address", "street"],
  linkedin: ["linkedin", "linked-in"],
  website: ["website", "portfolio", "personal website", "personal site"],
  visa_status: ["citizenship", "citizen", "visa status", "legally authorized", "authorized to work"],
  veteran_status: ["veteran", "military service"],
  disability_status: ["disability", "disabled"],
  hispanic_ethnicity: ["hispanic", "latino", "latina", "latine"],
  race: ["race", "ethnicity"],
  gender: ["gender", "sex"],
  sponsorship: ["sponsorship", "sponsor", "authorized to work", "work authorization", "visa", "require sponsorship"],
};
const GREENHOUSE_PROFILE_FIELDS = {
  country: null,
  first_name: "firstName",
  last_name: "lastName",
  email: "email",
  phone: "phoneNumber",
  address: "homeAddress",
  linkedin: "linkedinUrl",
  website: "websiteUrl",
  visa_status: "visaStatus",
  veteran_status: "veteranStatus",
  disability_status: "disabilityStatus",
  hispanic_ethnicity: "race",
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
const GREENHOUSE_CUSTOM_SELECT_VERIFY_DELAY_MS = 700;
const GREENHOUSE_CUSTOM_SELECT_RETRIES = 4;
const GREENHOUSE_CUSTOM_SELECT_RESCAN_PASSES = 8;
const GREENHOUSE_CUSTOM_SELECT_RESCAN_DELAY_MS = 600;

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

function demographicIntent(key, value) {
  const text = normalizedGreenhouseText(value);
  if (!text) return null;
  if (text.includes("do not wish") || text.includes("prefer not") || text.includes("decline") || text.includes("not disclose")) return "decline";
  if (key === "veteran_status") {
    if (text.includes("protected veteran") && !text.includes("not a") && !text.includes("not protected")) return "yes";
    if (text.includes("not a protected") || text.includes("not protected") || text === "no") return "no";
  }
  if (key === "disability_status") {
    if (text.includes("have a disability") && !text.startsWith("no")) return "yes";
    if (text.includes("no disability") || text.includes("do not have") || text === "no") return "no";
  }
  if (key === "hispanic_ethnicity") {
    if (text === "yes") return "yes";
    if (text === "no") return "no";
    if (text.includes("hispanic") || text.includes("latino") || text.includes("latina") || text.includes("latine")) return "yes";
    if (text.includes("not hispanic") || text.includes("not latino")) return "no";
  }
  return null;
}

function demographicOptionMatches(key, desiredValue, optionText) {
  const desired = normalizedGreenhouseText(desiredValue);
  const option = normalizedGreenhouseText(optionText);
  if (!desired || !option) return false;
  if (option === desired || option.includes(desired) || desired.includes(option)) return true;
  const intent = demographicIntent(key, desired);
  if (intent === "decline") return option.includes("decline") || option.includes("do not wish") || option.includes("prefer not") || option.includes("not disclose");
  if (intent === "yes") return option === "yes" || option.startsWith("yes ") || option.includes("protected veteran") && !option.includes("not protected") || option.includes("have a disability") && !option.startsWith("no");
  if (intent === "no") return option === "no" || option.startsWith("no ") || option.includes("not a protected") || option.includes("not protected") || option.includes("do not have");
  if (key === "gender") {
    if ((desired === "male" || desired === "man") && (option === "male" || option === "man")) return true;
    if ((desired === "female" || desired === "woman") && (option === "female" || option === "woman")) return true;
    if (desired.includes("non-binary") && (option.includes("non-binary") || option.includes("nonbinary"))) return true;
  }
  if (key === "race") {
    const aliases = {
      "black or african american": ["black", "african american"],
      "native hawaiian or other pacific islander": ["native hawaiian", "pacific islander"],
      "american indian or alaska native": ["american indian", "alaska native", "native american"],
      "two or more races": ["two or more", "multiple races", "multiracial"],
      "hispanic or latino": ["hispanic", "latino", "latina", "latine"],
    };
    const terms = aliases[desired] || [];
    if (terms.some((term) => option.includes(term))) return true;
  }
  if (key === "hispanic_ethnicity") {
    if (intent === "yes") return option === "yes" || option.startsWith("yes ");
    if (intent === "no") return option === "no" || option.startsWith("no ");
  }
  if (key === "visa_status") {
    if (desired.includes("us citizen")) return option.includes("citizen") && !option.includes("non-u.s") && !option.includes("non us");
    if (desired.includes("permanent resident")) return option.includes("permanent resident") || option.includes("green card");
    if (desired.includes("authorized to work")) return option.includes("authorized") || option.includes("work permit") || option === "yes";
    if (desired.includes("requiring sponsorship")) return option.includes("sponsor") || option.includes("require sponsorship") || option === "no";
    if (desired.includes("do not wish") || desired.includes("prefer not")) return option.includes("decline") || option.includes("prefer not") || option.includes("do not wish");
  }
  if (key === "country") {
    const unitedStates = option.includes("united states") || option.includes("usa") || option.includes("u.s.") || option.includes("+1") || option === "us";
    return unitedStates;
  }
  return false;
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
  const identifier = normalizedGreenhouseText(`${el.id || ""} ${el.name || ""}`);
  if (identifier.includes("hispanic") || identifier.includes("latino") || identifier.includes("latina")) {
    return "hispanic_ethnicity";
  }
  if (identifier.includes("citizenship") || identifier.includes("visa") || identifier.includes("authorized")) {
    return "visa_status";
  }
  const label = normalizedGreenhouseText(getGreenhouseFieldLabel(el));
  if (label.includes("citizenship") || label.includes("visa") || label.includes("authorized")) {
    return "visa_status";
  }
  return fieldKeyFromText(identifier) || fieldKeyFromText(label);
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
  const elements = [...document.querySelectorAll(
    "input, textarea, select, [id*='hispanic' i], [name*='hispanic' i], [id*='ethnicity' i], [name*='ethnicity' i]"
  )];
  return [...new Set(elements)]
    .filter((el) => !el.disabled && el.type !== "hidden" && isGreenhouseVisibleField(el))
    .map((el) => ({ el, key: getGreenhouseFieldKey(el) }))
    .filter((candidate) => {
      if (!candidate.key) return false;
      // React-Select's internal input belongs to the custom handler; native
      // select controls, including Hispanic/ethnicity selects, use this path.
      return candidate.el.tagName === "SELECT" ||
        !candidate.el.closest("div.select__container, div[class*='select__container'], div[class*='select__control']");
    });
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

  // 3. Existing fallbacks (kept as safety net)
  let label = container.querySelector("label.select__label, label");
  if (label) return label.innerText || label.textContent || "";
  // Labels often sit as sibling of the container inside same field wrapper
  let prev = container.previousElementSibling;
  let depth = 0;
  while (prev && depth < 4) {
    if (prev.matches && prev.matches("label.select__label, label")) {
      return prev.innerText || prev.textContent || "";
    }
    const inner = prev.querySelector && prev.querySelector("label.select__label, label");
    if (inner) return inner.innerText || inner.textContent || "";
    prev = prev.previousElementSibling;
    depth++;
  }
  // Parent wrapper search
  const parent = container.parentElement;
  if (parent) {
    const parentLabel = parent.querySelector("label.select__label, label");
    if (parentLabel) return parentLabel.innerText || parentLabel.textContent || "";
  }
  // Aria label on control as fallback
  const ariaEl = container.querySelector("[aria-label]");
  if (ariaEl) return ariaEl.getAttribute("aria-label") || "";
  // Last resort: first non-empty text line inside container's parent
  return "";
}

function getGreenhouseCustomSelectKey(container) {
  const identifier = normalizedGreenhouseText(`${container.id || ""} ${[...container.querySelectorAll("[id], [name]")].map((el) => `${el.id || ""} ${el.getAttribute("name") || ""}`).join(" ")}`);
  if (identifier.includes("hispanic") || identifier.includes("latino") || identifier.includes("latina")) {
    return "hispanic_ethnicity";
  }
  if (identifier.includes("citizenship") || identifier.includes("visa") || identifier.includes("authorized")) {
    return "visa_status";
  }
  const question = getGreenhouseCustomSelectQuestion(container);
  const normalizedQuestion = normalizedGreenhouseText(question);
  if (normalizedQuestion.includes("citizenship") || normalizedQuestion.includes("visa") || normalizedQuestion.includes("authorized")) {
    return "visa_status";
  }
  return fieldKeyFromText(question);
}

function findGreenhouseCustomSelects() {
  const candidates = [...document.querySelectorAll(
    "div.select__container, div[class*='select__container'], div[class*='select__control']"
  )];
  const hispanicInput = document.getElementById("hispanic_ethnicity");
  if (hispanicInput) {
    const hispanicContainer = hispanicInput.closest("div.select__container, div[class*='select__container']");
    if (hispanicContainer) candidates.unshift(hispanicContainer);
  }
  const containers = [...new Set(candidates.map((candidate) =>
    candidate.closest("div.select__container, div[class*='select__container']") || candidate
  ))];
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

function setReactControlledValue(el, value, key) {
  const prototype = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  try {
    if (key === "hispanic_ethnicity") {
      const control = el.closest("div.select__container, div[class*='select__container'], div.select__control, div[class*='select__control']");
      if (control && control !== el) {
        control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        control.click();
      }
    }
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    if (key === "hispanic_ethnicity") el.click();
  } catch (_) {}
  const selectedValue = el instanceof HTMLSelectElement
    ? [...el.options].find((option) =>
      demographicOptionMatches(key, value, option.textContent) ||
      demographicOptionMatches(key, value, option.value)
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
  const hasPI = ["firstName", "lastName", "phoneNumber", "email", "homeAddress", "linkedinUrl", "websiteUrl", "visaStatus", "veteranStatus", "disabilityStatus", "race", "gender"]
    .some((k) => typeof pi[k] === "string" && pi[k].trim().length > 0);
  // sponsorship "any" is default — treat as empty unless PI has something
  // If any PI field present, prefs is non-empty; sponsorship alone not enough to autofill
  return !hasPI;
}

function resolveGreenhouseValueForKey(key, question, preferences) {
  const pi = (preferences && preferences.personalInformation) || {};
  if (key === "country") return "United States +1";
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
  if (key === "visa_status") {
    const questionText = normalizedGreenhouseText(question);
    if (raw === "prefer_not") return "I do not wish to answer";
    if (questionText.includes("citizenship")) {
      return raw === "us_citizen" ? "Yes" : "No";
    }
    if (questionText.includes("authorized") || questionText.includes("work authorization")) {
      return raw === "requires_sponsorship" ? "No" : "Yes";
    }
    if (questionText.includes("sponsor")) return raw === "requires_sponsorship" ? "Yes" : "No";
    return {
      us_citizen: "U.S. citizen",
      permanent_resident: "U.S. permanent resident",
      work_authorized: "Non-U.S. citizen authorized to work",
      requires_sponsorship: "Non-U.S. citizen requiring sponsorship",
    }[raw] || "";
  }
  if (key === "hispanic_ethnicity") {
    const race = normalizedGreenhouseText(raw);
    if (race.includes("hispanic") || race.includes("latino") || race.includes("latina") || race.includes("latine")) return "Yes";
    // Any selected race category without a Hispanic/Latino label answers No.
    // This includes choices such as Asian, White, Black, or two or more races.
    return "No";
  }
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

function findGreenhouseBestOption(options, desiredValue, key) {
  const normVal = normalizedGreenhouseText(desiredValue);
  if (!normVal) return null;
  let target = options.find((o) => normalizedGreenhouseText(o.textContent) === normVal);
  if (target) return target;
  target = options.find((o) => normalizedGreenhouseText(o.value || "") === normVal);
  if (target) return target;
  target = options.find((o) => demographicOptionMatches(key, desiredValue, `${o.value || ""} ${o.textContent || ""}`));
  if (target) return target;
  // Substring either direction
  target = options.find((o) => {
    const t = normalizedGreenhouseText(o.textContent);
    return t.includes(normVal) || normVal.includes(t);
  });
  if (target) return target;
  return null;
}

async function selectGreenhouseOptionByClick(container, desiredValue, key) {
  const control = container.querySelector("div.select__control, div[class*='select__control']") || container;
  for (let attempt = 0; attempt < GREENHOUSE_CUSTOM_SELECT_RETRIES; attempt += 1) {
    try {
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      control.click();
      await greenhouseSleep(GREENHOUSE_CUSTOM_SELECT_OPEN_DELAY_MAX_MS + 250);
      const optionElements = [...document.querySelectorAll(
        "[role='option'], div.select__option, div[class*='select__option']"
      )].filter(isGreenhouseVisibleField);
      const option = findGreenhouseBestOption(optionElements, desiredValue, key);
      if (!option) continue;
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      option.click();
      await greenhouseSleep(GREENHOUSE_CUSTOM_SELECT_VERIFY_DELAY_MS);
      const selected = container.querySelector("div.select__single-value, div[class*='single-value']");
      if (selected && demographicOptionMatches(key, desiredValue, selected.textContent)) return true;
    } catch (error) {
      console.warn("[Randy] Greenhouse DOM dropdown attempt failed:", error && error.message ? error.message : error);
    }
  }
  return false;
}

async function fillGreenhouseCustomSelect(container, desiredValue, schema, key) {
  // Already filled check
  const singleValue = container.querySelector("div.select__single-value, div[class*='single-value']");
  if (singleValue && normalizedGreenhouseText(singleValue.textContent) === normalizedGreenhouseText(desiredValue)) {
    return false;
  }
  if (singleValue && findGreenhouseBestOption([singleValue], desiredValue, key)) {
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
        const fakeTarget = findGreenhouseBestOption(fakeOptions, desiredValue, key);
        if (fakeTarget) {
          const foundLabel = normalizedGreenhouseText(fakeTarget.textContent);
          option = fiber.options.find((o) => normalizedGreenhouseText(o.label) === foundLabel);
        }
      }
      if (option) {
        for (let attempt = 0; attempt < GREENHOUSE_CUSTOM_SELECT_RETRIES; attempt += 1) {
          try {
            fiber.selectOption(option);
            await greenhouseSleep(GREENHOUSE_CUSTOM_SELECT_VERIFY_DELAY_MS);
            const afterSingle = container.querySelector("div.select__single-value, div[class*='single-value']");
            const visibleLabel = afterSingle ? afterSingle.textContent : "";
            let verified = demographicOptionMatches(key, desiredValue, visibleLabel);
            if (!verified && typeof fiber.getValue === "function") {
              const got = fiber.getValue();
              verified = Array.isArray(got) && got[0] && demographicOptionMatches(key, desiredValue, got[0].label);
            }
            if (verified) return true;

            // Greenhouse may replace the React-Select tree after selection.
            // Reacquire the fiber and option before the next attempt.
            const freshInput = container.querySelector('input[role="combobox"]')
              || container.querySelector("div.select__input input")
              || container.querySelector('input[type="text"]')
              || container.querySelector("input");
            const freshFiber = freshInput && findGreenhouseSelectFiber(freshInput);
            if (freshFiber && Array.isArray(freshFiber.options)) {
              fiber = freshFiber;
              option = fiber.options.find((candidate) =>
                demographicOptionMatches(key, desiredValue, `${candidate.label} ${candidate.value}`)
              );
            }
          } catch (e) {
            console.warn("[Randy] Greenhouse fiber selectOption attempt failed:", e && e.message ? e.message : e);
          }
        }
      }
      console.warn("[Randy] No matching Greenhouse option", {
        key,
        desiredValue,
        options: fiber.options.map((o) => ({ label: o.label, value: o.value })),
      });
    }
  }

  // Real click fallback: Greenhouse sometimes clears direct React updates,
  // while its own menu click path updates the dependent form state correctly.
  if (await selectGreenhouseOptionByClick(container, desiredValue, key)) return true;

  // Last fallback: treat as text input and move on.
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
  console.log("[Randy] Greenhouse autofill state", {
    identity,
    nativeFields: findGreenhouseCandidateFields().map(({ el, key }) => ({ key, id: el.id, name: el.name })),
    customSelects: findGreenhouseCustomSelects().map(({ key, question }) => ({ key, question })),
    hasPreferences: Boolean(preferences),
  });
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

  // Greenhouse places the country selector beside the phone field. Fill it
  // first so the phone widget initializes with the United States (+1).
  for (const { container, key, question } of findGreenhouseCustomSelects()) {
    if (key !== "country" || !document.contains(container) || !isGreenhouseVisibleField(container)) continue;
    const desiredCountry = resolveGreenhouseValueForKey(key, question, preferences);
    const countrySchema = findGreenhouseSchemaValuesForKey(key, question, schema);
    const didFillCountry = await fillGreenhouseCustomSelect(container, desiredCountry, countrySchema, key);
    const selectedCountry = container.querySelector("div.select__single-value, div[class*='single-value']");
    const countryVerified = selectedCountry && demographicOptionMatches(key, desiredCountry, selectedCountry.textContent);
    if (didFillCountry || countryVerified) {
      usedKeys.add(key);
      if (didFillCountry) filled.push(key);
    }
    await greenhouseSleep(GREENHOUSE_CUSTOM_SELECT_RESCAN_DELAY_MS);
  }

  for (const { el, key } of findGreenhouseCandidateFields()) {
    if (key !== "country" || usedKeys.has(key)) continue;
    const desiredCountry = resolveGreenhouseValueForKey(key, "Country", preferences);
    setReactControlledValue(el, desiredCountry, key);
    usedKeys.add(key);
    filled.push(key);
    await greenhouseSleep(GREENHOUSE_CUSTOM_SELECT_RESCAN_DELAY_MS);
  }

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
      setReactControlledValue(el, value, key);
      filled.push(key);
      await greenhouseSleep(
        greenhouseRandInt(GREENHOUSE_AUTOFILL_FIELD_DELAY_MIN_MS, GREENHOUSE_AUTOFILL_FIELD_DELAY_MAX_MS)
      );
    }
    usedKeys.add(key);
  }

  // Custom controls can create dependent fields after selection, such as a
  // race dropdown appearing after Hispanic/Latino is answered. Rescan after
  // every settled selection so newly inserted controls are included.
  const customAttempts = new Map();
  for (let pass = 0; pass < GREENHOUSE_CUSTOM_SELECT_RESCAN_PASSES; pass += 1) {
    let foundPending = false;
    for (const { container, key, question } of findGreenhouseCustomSelects()) {
      if (usedKeys.has(key)) continue;
      const attempts = customAttempts.get(key) || 0;
      if (attempts >= GREENHOUSE_CUSTOM_SELECT_RETRIES) continue;
      if (!document.contains(container) || !isGreenhouseVisibleField(container)) continue;
      const desiredValue = resolveGreenhouseValueForKey(key, question, preferences);
      if (typeof desiredValue !== "string" || !desiredValue.trim()) continue;
      foundPending = true;
      customAttempts.set(key, attempts + 1);
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
      const didFill = await fillGreenhouseCustomSelect(container, desiredValue, schemaValues, key);
      const selected = container.querySelector("div.select__single-value, div[class*='single-value']");
      const verified = selected && demographicOptionMatches(key, desiredValue, selected.textContent);
      if (didFill || verified) {
        if (didFill && !filled.includes(key)) filled.push(key);
        usedKeys.add(key);
      }
      await greenhouseSleep(GREENHOUSE_CUSTOM_SELECT_RESCAN_DELAY_MS);
    }
    if (!foundPending) break;
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
  const hispanicControls = [...document.querySelectorAll(
    "input, textarea, select, [id*='hispanic' i], [name*='hispanic' i], [id*='ethnicity' i], [name*='ethnicity' i]"
  )].map((el) => ({
    tag: el.tagName,
    id: el.id || null,
    name: el.getAttribute("name") || null,
    type: el.getAttribute("type") || null,
    value: el.value || null,
    key: getGreenhouseFieldKey(el),
    visible: isGreenhouseVisibleField(el),
    disabled: Boolean(el.disabled),
    wrapper: el.closest("div.select__container, div[class*='select__container'], div.select__control, div[class*='select__control']")?.className || null,
    options: el.tagName === "SELECT" ? [...el.options].map((option) => ({ value: option.value, label: option.textContent.trim() })) : null,
  }));
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
    hispanicControls,
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

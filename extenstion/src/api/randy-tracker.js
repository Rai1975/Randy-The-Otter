/* Randy applied-jobs tracker — chrome.storage.local only.
 *
 * Key: randyAppliedJobs = [{ applied_at, source, job_id, title, company, status }]
 * Status enum: applied | rejected | interview | hired (default applied).
 * Empty by default — no backend seed, no CSV.
 *
 * Loaded in content scripts (before content.js) and in
 * src/applications/applications.html (before applications.js).
 * Plain script (no modules) so both contexts share globals.
 */

const RANDY_APPLIED_JOBS_KEY = "randyAppliedJobs";
const RANDY_APPLICATION_STATUSES = ["applied", "rejected", "interview", "hired"];
const RANDY_APPLIED_JOB_TEXT_MAX = 300;
const RANDY_APPLIED_QUESTION_MAX_TITLE = 45;

function cleanAppliedJobText(value) {
  const text = String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
  return text.length > RANDY_APPLIED_JOB_TEXT_MAX
    ? text.slice(0, RANDY_APPLIED_JOB_TEXT_MAX).trim()
    : text;
}

function normalizeAppliedJobStatus(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return RANDY_APPLICATION_STATUSES.includes(text) ? text : null;
}

function normalizeAppliedJobRecord(row) {
  const source = String((row && (row.source || row.site)) || "").trim();
  const jobId = String((row && (row.job_id || row.jobId)) || "").trim();
  return {
    applied_at: typeof (row && row.applied_at) === "string" ? row.applied_at : "",
    source,
    job_id: jobId,
    title: cleanAppliedJobText(row && row.title),
    company: cleanAppliedJobText(row && row.company),
    status: normalizeAppliedJobStatus(row && row.status) || "applied",
  };
}

function appliedJobsKey(source, jobId) {
  return `${String(source || "").trim()}::${String(jobId || "").trim()}`;
}

async function getAppliedJobs() {
  try {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return [];
    const result = await chrome.storage.local.get(RANDY_APPLIED_JOBS_KEY);
    const raw = result[RANDY_APPLIED_JOBS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeAppliedJobRecord).filter((r) => r.source && r.job_id);
  } catch (_) {
    return [];
  }
}

async function saveAppliedJobs(rows) {
  const cleaned = (Array.isArray(rows) ? rows : [])
    .map(normalizeAppliedJobRecord)
    .filter((r) => r.source && r.job_id)
    .slice(0, 1000);
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ [RANDY_APPLIED_JOBS_KEY]: cleaned });
      return cleaned;
    }
  } catch (_) {}
  return null;
}

async function appendAppliedJob({ source, job_id, title, company, status } = {}) {
  const rows = await getAppliedJobs();
  const record = normalizeAppliedJobRecord({
    applied_at: new Date().toISOString(),
    source,
    job_id,
    title,
    company,
    status: normalizeAppliedJobStatus(status) || "applied",
  });
  if (!record.source || !record.job_id) return { rows, added: false };
  const key = appliedJobsKey(record.source, record.job_id);
  if (rows.some((r) => appliedJobsKey(r.source, r.job_id) === key)) {
    return { rows, added: false };
  }
  const next = [...rows, record];
  await saveAppliedJobs(next);
  return { rows: next, added: true, job: record };
}

async function updateAppliedJobStatus(source, jobId, status) {
  const next = normalizeAppliedJobStatus(status);
  if (!next) return null;
  const rows = await getAppliedJobs();
  const key = appliedJobsKey(source, jobId);
  const idx = rows.findIndex((r) => appliedJobsKey(r.source, r.job_id) === key);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], status: next };
  await saveAppliedJobs(rows);
  return rows[idx];
}

async function deleteAppliedJob(source, jobId) {
  const rows = await getAppliedJobs();
  const key = appliedJobsKey(source, jobId);
  const next = rows.filter((r) => appliedJobsKey(r.source, r.job_id) !== key);
  if (next.length === rows.length) return false;
  await saveAppliedJobs(next);
  return true;
}

function buildAppliedQuestion(title) {
  let t = typeof title === "string" ? title.trim().toLowerCase() : "";
  if (!t) return "did you apply to that one?";
  if (t.length > RANDY_APPLIED_QUESTION_MAX_TITLE) {
    let cut = t.slice(0, RANDY_APPLIED_QUESTION_MAX_TITLE - 1).trimEnd();
    if (t[RANDY_APPLIED_QUESTION_MAX_TITLE - 1] && !/\s/.test(t[RANDY_APPLIED_QUESTION_MAX_TITLE - 1]) && cut.includes(" ")) {
      cut = cut.split(" ").slice(0, -1).join(" ").replace(/[\s,\-]+$/, "");
    }
    t = `${cut}…`;
  }
  return `did you apply to ${t}?`;
}

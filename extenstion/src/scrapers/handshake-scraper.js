/* Handshake job scraper — Handshake-specific extraction only.
 *
 * Supported URL form: any joinhandshake.com job-search page
 * (e.g. .../job-search/<id>), any college subdomain.
 *
 * Handshake's class names are unreliable, so the description is anchored
 * on visible text instead: find the h3 reading "Job description", walk up
 * two levels (h3 -> enclosing div -> description container), and read the
 * container's text. No class selectors involved.
 *
 * Console-only for now: results are logged, never rendered into the bubble.
 * The generic router (scraper.js) is the only caller — content.js stays
 * site-agnostic.
 */

/**
 * True when the current page is a Handshake job page: any college
 * subdomain of joinhandshake.com showing a job-search posting.
 * @returns {boolean}
 */
function isHandshakeJobPage() {
  if (!window.location.hostname.includes("joinhandshake.com")) {
    return false;
  }
  return window.location.pathname.includes("/job-search/");
}

/**
 * Job id from the trailing numeric path segment, else an `id` query
 * param, else null. Never throws.
 * @returns {string|null}
 */
function getHandshakeJobId() {
  const pathMatch = window.location.pathname.match(/(\d+)\/?$/);
  if (pathMatch) {
    return pathMatch[1];
  }
  const paramId = new URLSearchParams(window.location.search).get("id");
  return paramId || null;
}

/**
 * Normalize heading text for comparison: trim, lowercase, collapse
 * interior whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalizeHandshakeHeading(text) {
  return (text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Find the "Job description" h3. Prefers an exact (normalized) match,
 * falls back to a contains-match, prefers visible hits.
 * @returns {Element|null}
 */
function findHandshakeJobDescHeading() {
  const headings = [...document.querySelectorAll("h3")];
  if (!headings.length) {
    return null;
  }
  const scored = headings
    .map((el) => ({
      el,
      text: normalizeHandshakeHeading(el.innerText || el.textContent),
      visible: el.offsetParent !== null,
    }))
    .filter((candidate) => candidate.text.includes("job description"));
  if (!scored.length) {
    return null;
  }
  return (
    scored.find((c) => c.visible && c.text === "job description") ||
    scored.find((c) => c.text === "job description") ||
    scored.find((c) => c.visible) ||
    scored[0]
  ).el;
}

/**
 * Description via the heading anchor: h3 -> parent (enclosing div) ->
 * parent (description container). Returns the container's text with the
 * heading's own label stripped out. The nested details div inside comes
 * along as part of the container text.
 * @returns {string|null}
 */
function getHandshakeDescription() {
  const heading = findHandshakeJobDescHeading();
  if (!heading) {
    return null;
  }
  const enclosingDiv = heading.parentElement;
  if (!enclosingDiv) {
    return null;
  }
  const container = enclosingDiv.parentElement;
  if (!container) {
    return null;
  }
  const containerText = ((container.innerText || container.textContent) || "")
    .trim();
  if (!containerText) {
    return null;
  }
  const headingText = ((heading.innerText || heading.textContent) || "").trim();
  const stripped = headingText
    ? containerText.replace(headingText, "").trim()
    : containerText;
  return stripped || null;
}

/**
 * Wait until the "Job description" heading exists (Handshake renders job
 * panes lazily). Resolves true on first hit, false on timeout — never
 * throws.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForHandshakeJobContent(timeoutMs = 8000) {
  const startedAt = Date.now();
  for (;;) {
    if (findHandshakeJobDescHeading()) {
      return true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Scrape the currently-viewed Handshake job.
 * Title/company come from the GraphQL interceptor cache when available
 * (same isolated world — see handshake-bridge.js); description comes
 * from the DOM pane. Missing fields come back null. Never throws.
 * @param {object} [options] - { report: false } scrapes without POSTing
 * @returns {Promise<{site:string,jobId:string|null,title:string|null,company:string|null,description:string|null}|null>}
 */
async function scrapeHandshakeJob(options) {
  if (!isHandshakeJobPage()) {
    return null;
  }

  // The job pane renders lazily — don't single-shot an empty DOM.
  const contentReady = await waitForHandshakeJobContent();
  if (!contentReady) {
    console.warn(
      "[Randy] Handshake scrape: no job content rendered within timeout. " +
        "Run __randyHandshakeDebug() in the console for a DOM report."
    );
  }

  const jobId = getHandshakeJobId();
  const job = {
    site: "handshake",
    jobId,
    title: null,
    company: null,
    description: getHandshakeDescription(),
  };

  // Title/company only exist in the GraphQL interceptor cache
  // (bridge-populated, keyed by URL jobId). Merge best-effort so the
  // tracker (via window.__randyLastJob) records them on apply.
  try {
    var hsEntry = null;
    if (typeof getCurrentHandshakeJob === "function") {
      hsEntry = getCurrentHandshakeJob();
    } else if (typeof window.getCurrentHandshakeJob === "function") {
      hsEntry = window.getCurrentHandshakeJob();
    }
    if (!hsEntry && jobId && typeof window.getHandshakeCachedJob === "function") {
      hsEntry = window.getHandshakeCachedJob(jobId);
    } else if (!hsEntry && jobId && typeof getHandshakeCachedJobById === "function") {
      hsEntry = getHandshakeCachedJobById(jobId);
    }
    var hsParsed = hsEntry && hsEntry.parsed && typeof hsEntry.parsed === "object"
      ? hsEntry.parsed
      : null;
    if (hsParsed) {
      if (typeof hsParsed.title === "string" && hsParsed.title.trim()) {
        job.title = hsParsed.title.trim();
      }
      if (typeof hsParsed.company === "string" && hsParsed.company.trim()) {
        job.company = hsParsed.company.trim();
      }
    }
  } catch (_hsCacheErr) {}

  if (!job.jobId) {
    console.warn("[Randy] Handshake scrape: no jobId found on this page.");
  }
  if (!job.description) {
    console.warn("[Randy] Handshake scrape: no description found on this page.");
  }

  console.log("[Randy] Handshake job:", job);

  // Send the job JSON with our session_id; backend `reply` drives the bubble.
  // Skipped when the caller passes { report: false } so it can choose which
  // single request to send (e.g. click handler sends exactly one of job/click).
  if (
    (!options || options.report !== false) &&
    typeof sendRandyJob === "function"
  ) {
    sendRandyJob(job)
      .then((data) => {
        if (typeof setBubbleFromBackend === "function") {
          setBubbleFromBackend(data);
        }
      })
      .catch((error) => {
        console.warn("[Randy] Handshake backend send failed:", error);
      });
  }

  return job;
}

/**
 * Live DOM report for the current page. Run `__randyHandshakeDebug()` in
 * DevTools when a scrape comes back empty — it shows the gate verdict,
 * every h3 on the page, and the heading/container match so repairs are
 * evidence-based.
 * @returns {{url:string,jobId:string|null,isJobPage:boolean,headingFound:boolean,headingText:string|null,containerChars:number,h3Texts:string[]}}
 */
function debugHandshakeScrape() {
  const heading = findHandshakeJobDescHeading();
  let containerChars = 0;
  if (heading && heading.parentElement && heading.parentElement.parentElement) {
    const container = heading.parentElement.parentElement;
    containerChars = (((container.innerText || container.textContent) || ""))
      .trim().length;
  }
  const report = {
    url: window.location.href,
    jobId: getHandshakeJobId(),
    isJobPage: isHandshakeJobPage(),
    headingFound: Boolean(heading),
    headingText: heading
      ? ((heading.innerText || heading.textContent) || "").trim()
      : null,
    containerChars,
    h3Texts: [...document.querySelectorAll("h3")]
      .map((el) => ((el.innerText || el.textContent) || "").trim())
      .filter(Boolean)
      .slice(0, 30),
  };
  console.log("[Randy] Handshake debug report:", report);
  return report;
}

if (typeof window !== "undefined") {
  window.__randyHandshakeDebug = debugHandshakeScrape;
}

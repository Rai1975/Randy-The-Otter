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
 * Scrape the currently-viewed Handshake job (description only for v1).
 * Console-only: logs the result, never touches the bubble. Never throws.
 * @returns {Promise<{site:string,jobId:string|null,description:string|null}|null>}
 */
async function scrapeHandshakeJob() {
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

  const job = {
    site: "handshake",
    jobId: getHandshakeJobId(),
    description: getHandshakeDescription(),
  };

  if (!job.jobId) {
    console.warn("[Randy] Handshake scrape: no jobId found on this page.");
  }
  if (!job.description) {
    console.warn("[Randy] Handshake scrape: no description found on this page.");
  }

  console.log("[Randy] Handshake job:", job);
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

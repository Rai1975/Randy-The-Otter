/* LinkedIn job scraper — LinkedIn-specific extraction only.
 *
 * Two supported URL forms:
 *   1. Detail page:  /jobs/view/<slug>-<id>  (or /jobs/view/<id>)
 *   2. Search page:  /jobs/search/...?currentJobId=<id>
 *                     (also /jobs/collections/... and /jobs/search-results/...
 *                      variants — anything carrying currentJobId)
 *
 * Strategy (most-stable source first — LinkedIn renames CSS classes often):
 *   1. JSON-LD  (script[type="application/ld+json"] @type JobPosting)
 *   2. Stable hooks (data-testid, componentkey, semantic h1)
 *   3. Legacy BEM classes (last resort)
 *
 * Known-good live-DOM hook: the description lives under
 * [data-testid="expandable-text-box"].
 *
 * Console-only for now: results are logged, never rendered into the bubble.
 * The generic router (scraper.js) is the only caller — content.js stays
 * site-agnostic.
 */

const LINKEDIN_SELECTORS = {
  title: [
    "h1.job-details-jobs-unified-top-card__job-title",
    "h1.top-card-layout__title",
    ".job-details-jobs-unified-top-card__job-title",
  ],
  company: [
    ".job-details-jobs-unified-top-card__company-name",
    "a.topcard__org-name-link",
    ".top-card-layout__first-subline a",
  ],
  location: [
    ".job-details-jobs-unified-top-card__bullet",
    "span.topcard__flavor--bullet",
    ".jobs-unified-top-card__bullet",
  ],
  description: [
    '[data-testid="expandable-text-box"]',
    '[componentkey^="JobDetails_AboutTheJob"]',
    ".jobs-description__content",
    "div.show-more-less-html__markup",
    "#job-details",
  ],
  showMoreButton: [
    '[data-testid="expandable-text-box"] button',
    "button.jobs-description__footer-button",
    'button[aria-label*="show more"]',
    ".jobs-description__footer button",
  ],
};

/**
 * True when the current page shows a specific job: either a detail page
 * or any /jobs/ surface carrying a currentJobId param.
 * @returns {boolean}
 */
function isLinkedInJobPage() {
  if (!window.location.hostname.includes("linkedin.com")) {
    return false;
  }
  if (window.location.pathname.startsWith("/jobs/view/")) {
    return true;
  }
  const params = new URLSearchParams(window.location.search);
  return params.has("currentJobId");
}

/**
 * Job id from (in priority order): /jobs/view/ slug tail, currentJobId
 * query param, or a data-entity-urn jobPosting attribute in the DOM.
 * @returns {string|null}
 */
function getLinkedInJobId() {
  const viewMatch = window.location.pathname.match(/\/jobs\/view\/(?:.*-)?(\d+)/);
  if (viewMatch) {
    return viewMatch[1];
  }
  const paramId = new URLSearchParams(window.location.search).get("currentJobId");
  if (paramId) {
    return paramId;
  }
  const urnEl = document.querySelector('[data-entity-urn*="jobPosting:"]');
  if (urnEl) {
    const urnMatch = urnEl
      .getAttribute("data-entity-urn")
      .match(/jobPosting:(\d+)/);
    if (urnMatch) {
      return urnMatch[1];
    }
  }
  return null;
}

/**
 * First non-empty text across a ranked selector list. Falls back to
 * textContent because innerText is empty on hidden/collapsed nodes.
 * @param {string[]} selectors
 * @returns {string|null}
 */
function firstLinkedInText(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const text = ((el.innerText || el.textContent) || "").trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

/**
 * Find a JobPosting node inside JSON-LD script blocks (object, array,
 * or @graph shapes).
 * @returns {object|null}
 */
function findLinkedInJobPostingLd() {
  const blocks = document.querySelectorAll('script[type="application/ld+json"]');
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block.textContent);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed)
      ? parsed
      : parsed["@graph"] || [parsed];
    for (const node of candidates) {
      if (node && node["@type"] === "JobPosting") {
        return node;
      }
    }
  }
  return null;
}

/**
 * HTML description string -> plain text (block tags become newlines).
 * @param {string} html
 * @returns {string}
 */
function linkedInHtmlToText(html) {
  return (html || "")
    .replace(/<(br|p|div|li|ul|ol|h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Human-readable location from a JSON-LD jobLocation node.
 * @param {object|string|Array} jobLocation
 * @returns {string|null}
 */
function linkedInLocationFromLd(jobLocation) {
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (!loc) {
    return null;
  }
  if (typeof loc === "string") {
    return loc;
  }
  const addr = loc.address || {};
  return (
    [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .filter(Boolean)
      .join(", ") || null
  );
}

/**
 * Best-guess expand control: prefer an explicitly-collapsed button, then one
 * whose label says "more", then the first candidate. The in-box selector can
 * match non-expand buttons, so blind-first-pick could mis-click.
 * @returns {Element|null}
 */
function findLinkedInExpandButton() {
  const seen = new Set();
  const candidates = [];
  for (const selector of LINKEDIN_SELECTORS.showMoreButton) {
    for (const el of document.querySelectorAll(selector)) {
      if (!seen.has(el)) {
        seen.add(el);
        candidates.push(el);
      }
    }
  }
  return (
    candidates.find((el) => el.getAttribute("aria-expanded") === "false") ||
    candidates.find((el) =>
      /more/i.test(
        `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`
      )
    ) ||
    candidates[0] ||
    null
  );
}

/**
 * Click the description "show more" button (if collapsed) and wait for the
 * description text to grow. No-op when already expanded or absent.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function expandLinkedInDescription(timeoutMs = 2500) {
  const button = findLinkedInExpandButton();
  if (!button || button.getAttribute("aria-expanded") === "true") {
    return;
  }
  const before = (firstLinkedInText(LINKEDIN_SELECTORS.description) || "").length;
  button.click();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = (firstLinkedInText(LINKEDIN_SELECTORS.description) || "").length;
    if (after > before) {
      return;
    }
  }
}

/**
 * Wait until any known title/description signal exists (LinkedIn renders the
 * job pane lazily, especially on search surfaces). Resolves true on first
 * hit, false on timeout — never throws.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForLinkedInJobContent(timeoutMs = 8000) {
  const startedAt = Date.now();
  for (;;) {
    const hasTitle = firstLinkedInText(LINKEDIN_SELECTORS.title);
    const hasDescription = firstLinkedInText(LINKEDIN_SELECTORS.description);
    if (hasTitle || hasDescription || findLinkedInJobPostingLd()) {
      return true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Scrape the currently-viewed LinkedIn job. Logs the result and POSTs it
 * (rendering the backend `reply`) unless called with { report: false }.
 * Never throws — missing fields come back null.
 * @param {object} [options] - { report: false } scrapes without POSTing
 * @returns {Promise<{site:string,jobId:string|null,title:string|null,company:string|null,location:string|null,description:string|null}|null>}
 */
async function scrapeLinkedInJob(options) {
  if (!isLinkedInJobPage()) {
    return null;
  }

  // The detail pane renders lazily — don't single-shot an empty DOM.
  const contentReady = await waitForLinkedInJobContent();
  if (!contentReady) {
    console.warn(
      "[Randy] LinkedIn scrape: no job content rendered within timeout. " +
        "Run __randyDebugScrape() in the console for a selector report."
    );
  }

  const job = {
    site: "linkedin",
    jobId: getLinkedInJobId(),
    title: null,
    company: null,
    location: null,
    description: null,
  };

  // 1. JSON-LD first — immune to CSS class renames, often has full text.
  try {
    const posting = findLinkedInJobPostingLd();
    if (posting) {
      job.title = (posting.title || "").trim() || null;
      const org = posting.hiringOrganization;
      job.company =
        (typeof org === "string" ? org : org && org.name
          ? org.name
          : null) || null;
      job.location = linkedInLocationFromLd(posting.jobLocation);
      job.description = linkedInHtmlToText(posting.description) || null;
    }
  } catch (error) {
    console.warn("[Randy] LinkedIn JSON-LD parse failed:", error);
  }

  // 2. DOM fills whatever JSON-LD missed (search pages often have no JSON-LD).
  if (!job.title) {
    job.title = firstLinkedInText(LINKEDIN_SELECTORS.title);
  }
  if (!job.company) {
    job.company = firstLinkedInText(LINKEDIN_SELECTORS.company);
  }
  if (!job.location) {
    job.location = firstLinkedInText(LINKEDIN_SELECTORS.location);
  }
  if (!job.description) {
    await expandLinkedInDescription();
    job.description = firstLinkedInText(LINKEDIN_SELECTORS.description);
  }

  for (const field of ["jobId", "title", "company", "location", "description"]) {
    if (!job[field]) {
      console.warn(`[Randy] LinkedIn scrape: no ${field} found on this page.`);
    }
  }

  console.log("[Randy] LinkedIn job:", job);

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
        console.warn("[Randy] LinkedIn backend send failed:", error);
      });
  }

  return job;
}

/**
 * Live selector health report for the current page. Run
 * `__randyDebugScrape()` in DevTools when a scrape comes back empty — it
 * shows exactly which layer failed (no JSON-LD? pane not rendered? which
 * selectors hit?) so registry repairs are evidence-based.
 * @returns {{url:string,jobId:string|null,isJobPage:boolean,jsonLdFound:boolean,fields:Object}}
 */
function debugLinkedInScrape() {
  const fields = {};
  for (const [field, selectors] of Object.entries(LINKEDIN_SELECTORS)) {
    fields[field] = selectors.map((selector) => {
      let matched = 0;
      let chars = 0;
      try {
        const nodes = document.querySelectorAll(selector);
        matched = nodes.length;
        const first = nodes[0];
        if (first) {
          chars = (((first.innerText || first.textContent) || "").trim())
            .length;
        }
      } catch {
        matched = -1;
      }
      return { selector, matched, chars };
    });
  }
  const report = {
    url: window.location.href,
    jobId: getLinkedInJobId(),
    isJobPage: isLinkedInJobPage(),
    jsonLdFound: Boolean(findLinkedInJobPostingLd()),
    testIds: [...document.querySelectorAll("[data-testid]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 60),
    fields,
  };
  console.log("[Randy] LinkedIn debug report:", report);
  return report;
}

if (typeof window !== "undefined") {
  window.__randyDebugScrape = debugLinkedInScrape;
}

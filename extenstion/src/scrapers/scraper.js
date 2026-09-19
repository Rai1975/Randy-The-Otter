/* Randy job scraper router — site-agnostic dispatcher.
 *
 * content.js calls ONLY scrapeCurrentJob(). Each supported site owns its
 * scraper module (e.g. linkedin-scraper.js) with site-specific function
 * names. Adding a site later means: new file + one SITE_SCRAPERS line +
 * a manifest match pattern. No other code changes.
 *
 * Site scrapers POST { session_id, type: "job", job } and render the
 * backend `reply` into the bubble via setBubbleFromBackend() — unless
 * called with { report: false }, in which case they only scrape and return
 * the job so the caller can choose which single request to send.
 */

// Registry: site key -> site scraper function. Site modules must load
// before this file (see manifest.json content_scripts order).
const SITE_SCRAPERS = {
  linkedin: scrapeLinkedInJob,
  handshake: scrapeHandshakeJob,
};

/**
 * Which supported job site is this page on?
 * @returns {string|null} site key or null when unsupported
 */
function detectSite() {
  const hostname = window.location.hostname;
  if (hostname.includes("linkedin.com")) {
    return "linkedin";
  }
  if (hostname.includes("joinhandshake.com")) {
    return "handshake";
  }
  return null;
}

/**
 * Minimal job identity tagged by every site scraper before reporting:
 * { source, job_id } — enough to log an application and dedupe the
 * "Did you apply?" prompt per session without needing the full job.
 * Scrapers SHOULD also attach title/company when available so the
 * tracker row is enriched (never required for the key itself).
 * @returns {string|null}
 */
function randyJobKey(source, jobId) {
  if (!source || !jobId) return null;
  return `${source}:${jobId}`;
}

/**
 * Scrape the currently-viewed job on whatever supported site this is.
 * @param {object} [options] - pass { report: false } to scrape without
 *   POSTing, so the caller can decide which single request to send
 * @returns {Promise<object|null>} job object or null (unsupported page / failure)
 */
async function scrapeCurrentJob(options) {
  const site = detectSite();
  if (!site) {
    return null;
  }
  const siteScraper = SITE_SCRAPERS[site];
  if (typeof siteScraper !== "function") {
    console.warn(`[Randy] No scraper registered for site: "${site}"`);
    return null;
  }
  try {
    const job = await siteScraper(options);
    // Remember the last successfully-scraped posting so the dwell watcher
    // can ask "Did you apply to that one?" when the user navigates away.
    if (
      job &&
      typeof job === "object" &&
      job.jobId &&
      typeof window !== "undefined"
    ) {
      window.__randyLastJob = job;
      window.__randyLastJobUrl = window.location.href;
    }
    return job;
  } catch (error) {
    console.warn(`[Randy] ${site} scrape failed:`, error);
    return null;
  }
}

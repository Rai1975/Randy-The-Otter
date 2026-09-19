/* Randy job scraper router — site-agnostic dispatcher.
 *
 * content.js calls ONLY scrapeCurrentJob(). Each supported site owns its
 * scraper module (e.g. linkedin-scraper.js) with site-specific function
 * names. Adding a site later means: new file + one SITE_SCRAPERS line +
 * a manifest match pattern. No other code changes.
 *
 * Console-only for now: results are logged by the site scrapers, never
 * rendered into the bubble.
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
 * Scrape the currently-viewed job on whatever supported site this is.
 * @returns {Promise<object|null>} job object or null (unsupported page / failure)
 */
async function scrapeCurrentJob() {
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
    return await siteScraper();
  } catch (error) {
    console.warn(`[Randy] ${site} scrape failed:`, error);
    return null;
  }
}

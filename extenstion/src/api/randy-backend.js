/* Randy backend client — shared POST helper for scraped job JSON.
 *
 * Loaded FIRST in manifest.json content_scripts so site scrapers
 * (linkedin/handshake) can call sendRandyJob(). Fire-and-forget:
 * never throws, so scrape flow is unaffected when the backend is down.
 */

const RANDY_JOB_SUMMARY_URL = "http://127.0.0.1:5000/job-summary";

/**
 * POST the whole job object to the Randy backend echo endpoint.
 * @param {object} job - scraped job JSON (sent as-is)
 * @returns {Promise<object|null>} backend response or null on failure
 */
async function sendRandyJob(job) {
  if (!job) {
    return null;
  }
  try {
    const response = await fetch(RANDY_JOB_SUMMARY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    if (!response.ok) {
      console.warn(
        `[Randy] Backend responded ${response.status} for job ${job.jobId || "(no id)"}`
      );
      return null;
    }
    const data = await response.json().catch(() => null);
    console.log("[Randy] Backend echo:", data);
    return data;
  } catch (error) {
    console.warn("[Randy] Backend POST failed (is server.py running?):", error);
    return null;
  }
}

console.log("Randy loaded!");

// After an extension reload/update, content scripts already running in open
// tabs become ORPHANED: chrome.runtime.id is undefined and getURL() returns
// "chrome-extension://invalid/..." — every image/font request then fails and
// stacks. Detect that here, warn once, and never fire invalid requests.
// (Real fix on reload: refresh the LinkedIn tab.)
const RANDY_EXTENSION_OK = Boolean(
  typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id
);

if (!RANDY_EXTENSION_OK) {
  console.warn(
    "[Randy] Extension context invalid (orphaned script after reload). " +
      "Refresh the LinkedIn tab to reload Randy."
  );
}

// Sprite map — default is "idle". Future states just add entries here
// (e.g. happy, sad) and call setRandySprite(name).
const RANDY_SPRITES = {
  idle: RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/idle-alert.gif")
    : null,
  talking: RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/talk.gif")
    : null,
};

let currentSprite = "idle";

// Preload all sprites so future idle <-> talking swaps don't flicker.
// Skipped entirely when orphaned — no invalid requests.
if (RANDY_EXTENSION_OK) {
  Object.values(RANDY_SPRITES).forEach((url) => {
    const preload = new Image();
    preload.src = url;
  });
}

// Pixel font loads here (not in static CSS) so an orphaned script never
// fires a font request. Orphaned tabs simply render the fallback stack
// declared in content.css ("Courier New", monospace).
if (
  RANDY_EXTENSION_OK &&
  typeof FontFace !== "undefined" &&
  document.fonts
) {
  try {
    const randyFont = new FontFace(
      "Press Start 2P",
      `url(${chrome.runtime.getURL(
        "src/assets/press-start-2p-latin.woff2"
      )}) format("woff2")`,
      { weight: "400", style: "normal" }
    );
    randyFont
      .load()
      .then((loadedFont) => document.fonts.add(loadedFont))
      .catch(() => {});
  } catch {
    // Font is decorative — fallbacks cover any failure silently.
  }
}

/**
 * Swap Randy's displayed gif.
 * @param {keyof typeof RANDY_SPRITES} name - sprite key from RANDY_SPRITES
 * @returns {boolean} true if swapped, false on unknown name
 */
function setRandySprite(name) {
  if (!RANDY_SPRITES[name]) {
    console.warn(`[Randy] Unknown sprite: "${name}"`);
    return false;
  }

  const img = document.querySelector("#randy-character");
  if (!img) {
    console.warn("[Randy] Character image not found yet.");
    return false;
  }

  currentSprite = name;
  img.src = RANDY_SPRITES[name];
  return true;
}

function createRandy() {
  // Guard against double-injection on LinkedIn SPA navigations.
  if (document.getElementById("randy")) {
    return document.getElementById("randy");
  }

  const randy = document.createElement("div");
  randy.id = "randy";

  // Chat bubble lives in its own component (bubble.js / bubble.css).
  // Initial "..." is a loading placeholder only — the greeting text itself
  // always comes from the backend `reply` (session-scoped).
  const { wrap: bubbleWrap } = createBubble("...");

  const character = document.createElement("img");
  character.id = "randy-character";
  // Only set src for real extension URLs — never chrome-extension://invalid/.
  if (RANDY_SPRITES[currentSprite]) {
    character.src = RANDY_SPRITES[currentSprite];
  }
  character.alt = "Randy the Otter";
  character.draggable = false;

  // If the gif fails to load (missing resource, CSP), keep the bubble usable.
  character.addEventListener("error", () => {
    console.warn("[Randy] Failed to load sprite:", character.src);
    character.style.display = "none";
  });

  // All bubble text comes from the backend. Fire the session greeting once
  // per page load; the backend echoes our session_id in its reply.
  if (typeof sendRandyEvent === "function") {
    sendRandyEvent("greeting")
      .then((data) => {
        if (typeof setBubbleFromBackend === "function") {
          setBubbleFromBackend(data);
        }
      })
      .catch((error) => {
        console.warn("[Randy] Greeting failed:", error);
      });
  }

  // Yes/No answers POST { session_id, type: "answer" }; reply drives bubble.
  async function handleRandyAnswer(answer) {
    if (typeof sendRandyEvent !== "function") {
      return;
    }
    try {
      const data = await sendRandyEvent("answer", { answer });
      if (typeof setBubbleFromBackend === "function") {
        setBubbleFromBackend(data);
      }
    } catch (error) {
      console.warn("[Randy] Answer send failed:", error);
    }
  }

  bubbleWrap.addEventListener("click", async () => {
    // Exactly ONE request per click: scrape first without reporting, then
    // send the job when one is on screen, otherwise a plain click event.
    // (Previously both a click event and a job POST fired per click.)
    setBubbleText("...");
    try {
      let job = null;
      if (typeof scrapeCurrentJob === "function") {
        job = await scrapeCurrentJob({ report: false });
      }
      let data = null;
      if (job && typeof sendRandyJob === "function") {
        data = await sendRandyJob(job);
      } else if (typeof sendRandyEvent === "function") {
        data = await sendRandyEvent("click");
      }
      if (typeof setBubbleFromBackend === "function") {
        setBubbleFromBackend(data);
      }
    } catch (error) {
      console.warn("[Randy] Click failed:", error);
    }
  });

  randy.appendChild(bubbleWrap);
  randy.appendChild(character);
  document.body.appendChild(randy);

  if (typeof createChoiceButtons === "function") {
    createChoiceButtons(handleRandyAnswer);
  }

  return randy;
}

createRandy();

// Dwell-gated auto-scrape: fire only after the user sits on the same URL
// for 2s. LinkedIn is an SPA (no reloads between jobs), so watch for URL
// changes and restart the timer. Same page-load session_id is reused —
// no refresh needed. The scraper renders the backend job `reply` itself.
(function startDwellScrape() {
  if (typeof scrapeCurrentJob !== "function") {
    return;
  }

  // Same isolated world survives re-injection after an extension reload, so
  // a previous instance's timers may still be alive — clear them first or
  // intervals/scrapes stack up.
  if (window.__randyDwellTimer) {
    clearTimeout(window.__randyDwellTimer);
    window.__randyDwellTimer = null;
  }
  if (window.__randyDwellWatcher) {
    clearInterval(window.__randyDwellWatcher);
    window.__randyDwellWatcher = null;
  }

  const DWELL_MS = 2000;
  let lastUrl = window.location.href;

  function schedule() {
    if (window.__randyDwellTimer) {
      clearTimeout(window.__randyDwellTimer);
    }
    window.__randyDwellTimer = setTimeout(() => {
      window.__randyDwellTimer = null;
      if (window.location.href === lastUrl) {
        scrapeCurrentJob().catch((error) => {
          console.warn("[Randy] Dwell scrape failed:", error);
        });
      }
    }, DWELL_MS);
  }

  schedule();
  window.__randyDwellWatcher = setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      schedule();
    }
  }, 500);
})();

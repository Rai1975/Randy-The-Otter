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

  // No greeting on page load: the bubble stays invisible until the backend
  // actually has a comment to make (random gate on ambient job sightings).
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

  // Click now just toggles the action menu (hover still opens it too).
  // No job message is forced on click — Roast owns that flow.
  // Yes/No buttons and menu items stopPropagation, so answering / picking
  // an action never retriggers this toggle.
  randy.addEventListener("click", () => {
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (typeof isMenuVisible === "function" && typeof setMenuVisible === "function") {
      setMenuVisible(!isMenuVisible());
    } else if (typeof setMenuVisible === "function") {
      setMenuVisible(true);
    }
  });

  /**
   * Generic menu action handler: scrape without reporting, then POST the
   * single job endpoint with an explicit `action` (bypasses the random gate).
   * Roast uses the same path; cover-letter returns LaTeX in `payload`.
   */
  async function handleMenuAction(action) {
    if (typeof setMenuVisible === "function") {
      setMenuVisible(false);
    }
    if (typeof setBubbleVisible === "function") {
      setBubbleVisible(true);
    }
    setBubbleText("...");
    try {
      let job = null;
      if (typeof scrapeCurrentJob === "function") {
        job = await scrapeCurrentJob({ report: false });
      }
      let data = null;
      if (typeof sendRandyEvent === "function") {
        data = await sendRandyEvent("job", { job, action, trigger: action });
      }
      if (data) {
        if (data.payload) {
          console.log(`[Randy] ${action} payload:`, data.payload);
        }
        if (typeof setBubbleFromBackend === "function") {
          setBubbleFromBackend(data);
        }
      } else if (typeof setBubbleVisible === "function") {
        setBubbleVisible(false);
      }
    } catch (error) {
      console.warn(`[Randy] ${action} failed:`, error);
      if (typeof setBubbleVisible === "function") {
        setBubbleVisible(false);
      }
    }
  }

  async function handleRoast() {
    return handleMenuAction("roast");
  }

  randy.appendChild(bubbleWrap);
  randy.appendChild(character);
  document.body.appendChild(randy);

  if (typeof createChoiceButtons === "function") {
    createChoiceButtons(handleRandyAnswer);
  }

  // Hover menu: all three actions talk to the backend job endpoint
  // (explicit actions bypass the random gate). payload-bearing replies
  // (cover-letter LaTeX) are console.logged for now; future: pdf download.
  if (typeof createMenu === "function") {
    createMenu((actionId) => {
      handleMenuAction(actionId);
    });
  }

  const HOVER_MENU_DELAY_MS = 1000;
  // Grace period before the open menu closes after the mouse leaves, so
  // briefly slipping off Randy doesn't instantly dismiss it. Re-entering
  // in time cancels the close.
  const HOVER_MENU_HIDE_DELAY_MS = 2500;
  randy.addEventListener("mouseenter", () => {
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (window.__randyMenuHideTimer) {
      clearTimeout(window.__randyMenuHideTimer);
      window.__randyMenuHideTimer = null;
    }
    window.__randyHoverTimer = setTimeout(() => {
      window.__randyHoverTimer = null;
      if (typeof setMenuVisible === "function") {
        setMenuVisible(true);
      }
    }, HOVER_MENU_DELAY_MS);
  });
  randy.addEventListener("mouseleave", () => {
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (window.__randyMenuHideTimer) {
      clearTimeout(window.__randyMenuHideTimer);
    }
    window.__randyMenuHideTimer = setTimeout(() => {
      window.__randyMenuHideTimer = null;
      if (typeof setMenuVisible === "function") {
        setMenuVisible(false);
      }
    }, HOVER_MENU_HIDE_DELAY_MS);
  });

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

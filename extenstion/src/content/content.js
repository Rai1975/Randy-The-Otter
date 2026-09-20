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
  roast: RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/roast.gif")
    : null,
  "roast-talking": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/roast-talk.gif")
    : null,
  // Edge poses: he lives off the right edge and only steps out when asked.
  peek: RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/peek.gif")
    : null,
  "peek-talking": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/peek-talk.gif")
    : null,
  "peek-roast": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/peek-roast.gif")
    : null,
  "peek-roast-talking": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/peek-roast-talk.gif")
    : null,
  // Held while a line is still on screen after he has stopped speaking —
  // he stays leaning out and attentive instead of dropping straight back
  // to the resting peek, which read as if he'd lost interest mid-sentence.
  "peek-waiting": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/peek-wait.gif")
    : null,
  "peek-roast-waiting": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/peek-roast-wait.gif")
    : null,
  "jump-in": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/jump-in.gif")
    : null,
  "jump-out": RANDY_EXTENSION_OK
    ? chrome.runtime.getURL("src/assets/jump-out.gif")
    : null,
  // Poke reactions, in escalating order.
  "poke-1": RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/poke-1-glance.gif") : null,
  "poke-2": RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/poke-2-startle.gif") : null,
  "poke-3": RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/poke-3-irritated.gif") : null,
  "poke-4": RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/poke-4-annoyed.gif") : null,
  "poke-5": RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/poke-5-turns-away.gif") : null,
  // Frozen last frame of poke-5 — holds the sulk, since letting the turn
  // itself loop would spin him back to front and away again.
  "poke-turned": RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/poke-turned.gif") : null,
  "poke-return": RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/poke-return.gif") : null,
};

// The log is a separate layer behind Randy — he stands on it, so it cannot
// be part of his own sprite sheet.
const RANDY_LOG_SPRITES = {
  in: RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/log-slide-in.gif") : null,
  idle: RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/log-idle.gif") : null,
  out: RANDY_EXTENSION_OK ? chrome.runtime.getURL("src/assets/log-slide-out.gif") : null,
};
const RANDY_LOG_IN_MS = 570;
const RANDY_LOG_OUT_MS = 480;
let randyLogTimer = null;

/**
 * Show or hide the log Randy stands on. It slides in alongside his jump so
 * it arrives under him as he lands, and slides back out as he leaves.
 * @param {boolean} on
 */
function setRandyLog(on) {
  const log = document.querySelector("#randy-log");
  const randy = document.querySelector("#randy");
  if (!log || !randy) return;

  if (randyLogTimer) {
    clearTimeout(randyLogTimer);
    randyLogTimer = null;
  }

  if (on) {
    randy.dataset.log = "on";
    log.style.display = "block";
    if (RANDY_LOG_SPRITES.in) log.src = RANDY_LOG_SPRITES.in;
    randyLogTimer = setTimeout(() => {
      randyLogTimer = null;
      // The slide gifs loop, so settle onto the resting one once it lands.
      if (RANDY_LOG_SPRITES.idle) log.src = RANDY_LOG_SPRITES.idle;
    }, RANDY_LOG_IN_MS);
    return;
  }

  if (log.style.display !== "block") return;
  // Drop the lift immediately so he rides the log down rather than hanging
  // in the air above it.
  delete randy.dataset.log;
  if (RANDY_LOG_SPRITES.out) log.src = RANDY_LOG_SPRITES.out;
  randyLogTimer = setTimeout(() => {
    randyLogTimer = null;
    log.style.display = "none";
  }, RANDY_LOG_OUT_MS);
}

// He starts tucked behind the right edge, not standing on the page.
let currentSprite = "peek";

// Randy has two moods, each with an idle and a talking sprite. Mood is sticky
// (a roast leaves him smug until another action snaps him out of it); talking
// is timed off the length of whatever line he's saying.
let randyMood = "normal";
let randyIsSpeaking = false;
// Where he lives: "peek" (tucked behind the right edge, the resting state)
// or "out" (standing on the page). randyTransition holds the one-shot jump
// that is mid-play, which overrides both.
let randyPose = "peek";
let randyTransition = null;

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

// ---------------------------------------------------------------------------
// Handshake cache helpers (bridge-provided, parsed-only, ephemeral)
// ---------------------------------------------------------------------------
// handshake-bridge.js (document_start, ISOLATED) populates
// window.__randyHandshakeJobCache keyed by URL jobId (= GraphQL job.id).
// All GetExtendedJobDetails batches on the search page land here at the
// start; lost on refresh / ?page= change by design. Backend wiring is
// deferred — these helpers just expose the cache for upcoming API calls.
//
//   getHandshakeCachedJobForCurrentUrl() -> {parsed, jobId, url, timestamp}|null
//   getHandshakeCachedJobById(id)        -> same or null
//   getHandshakeCacheSnapshot()          -> { [jobId]: parsed }
// Content.js and bridge share the same ISOLATED world, so window.* is shared.

function getHandshakeCachedJobForCurrentUrl() {
  try {
    if (typeof window.getCurrentHandshakeJob === "function") return window.getCurrentHandshakeJob();
    if (typeof getCurrentHandshakeJob === "function") return getCurrentHandshakeJob();
  } catch (_e) {}
  return null;
}

function getHandshakeCachedJobById(jobId) {
  try {
    if (typeof window.getHandshakeCachedJob === "function") return window.getHandshakeCachedJob(jobId);
    if (typeof getHandshakeCachedJob === "function") return getHandshakeCachedJob(jobId);
  } catch (_e) {}
  return null;
}

function getHandshakeCacheSnapshot() {
  try {
    if (typeof window.__randyHandshakeJobs === "function") return window.__randyHandshakeJobs();
  } catch (_e) {}
  try {
    if (window.__randyHandshakeJobCache) {
      var out = {};
      var keys = Object.keys(window.__randyHandshakeJobCache);
      for (var i = 0; i < keys.length; i++) out[keys[i]] = window.__randyHandshakeJobCache[keys[i]].parsed;
      return out;
    }
  } catch (_e) {}
  return {};
}

// Example future wiring (DO NOT enable yet — backend hook deferred):
//   var entry = getHandshakeCachedJobForCurrentUrl();
//   if (entry) {
//     // send via API keyed by entry.jobId (URL trailing id == job.id)
//     // payload: { site:"handshake", jobId: entry.jobId, ...entry.parsed }
//     // postRandyEnvelope({ type:"job", job: { site:"handshake", jobId: entry.jobId, ...entry.parsed }, trigger: action })
//   }

/**
 * Ensure Randy exists in DOM — re-creates if SPA navigation detached it.
 * @returns {HTMLElement|null} #randy element
 */
function ensureRandyExists() {
  if (document.getElementById("randy")) return document.getElementById("randy");
  // Body may not be ready during very early document_start on some SPAs
  if (!document.body) return null;
  // Avoid re-entry while already creating
  try {
    return createRandy();
  } catch (e) {
    console.warn("[Randy] ensureRandyExists failed:", e);
    return null;
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

  let img = document.querySelector("#randy-character");
  if (!img) {
    const re = ensureRandyExists();
    img = re ? document.querySelector("#randy-character") : document.querySelector("#randy-character");
    if (!img) {
      console.warn("[Randy] Character image not found yet.");
      return false;
    }
  }

  currentSprite = name;
  // Avoid redundant src assignment which restarts gif decode and flickers
  if (img.src !== RANDY_SPRITES[name]) img.src = RANDY_SPRITES[name];
  // content.css nudges each pose onto the shared floor via this attribute.
  if (img.dataset.sprite !== name) img.dataset.sprite = name;
  // Ensure visible if previously hidden by a transient load error
  if (img.style.display === "none") img.style.display = "";
  return true;
}

/** Pick the sprite for the current pose, mood and speaking state. */
function syncRandySprite() {
  // A jump is a one-shot that owns the sprite until it finishes.
  if (randyTransition) {
    setRandySprite(randyTransition);
    return;
  }
  // Then a poke reaction, which outranks whatever he was doing — being
  // prodded interrupts you.
  if (randyPokeAnim) {
    setRandySprite(randyPokeAnim);
    return;
  }
  // Sulking: held until he calms down, even through replies.
  if (randyPokeTurned) {
    setRandySprite("poke-turned");
    return;
  }
  const roast = randyMood === "roast";
  // Peeking has its own full set, so a roast keeps its smug face even from
  // the edge — mood survives the pose change in both directions.
  if (randyPose === "peek") {
    if (randyIsSpeaking) {
      setRandySprite(roast ? "peek-roast-talking" : "peek-talking");
      return;
    }
    // Done talking but the line is still up: hold the attentive pose until
    // the bubble actually clears.
    const waiting =
      typeof randyBubbleShowing === "function" && randyBubbleShowing();
    if (waiting) {
      setRandySprite(roast ? "peek-roast-waiting" : "peek-waiting");
      return;
    }
    setRandySprite(roast ? "peek-roast" : "peek");
    return;
  }
  setRandySprite(
    randyIsSpeaking
      ? roast
        ? "roast-talking"
        : "talking"
      : roast
      ? "roast"
      : "idle"
  );
}

// Length of jump-in / jump-out. The gifs loop forever, so the code plays a
// single pass by swapping the sprite out when this elapses.
const RANDY_JUMP_MS = 530;
// How long he stays on the page with nothing happening before retreating.
const RANDY_IDLE_RETREAT_MS = 20000;
let randyIdleTimer = null;

// Poke escalation. Clicking Randy while he is out on the page prods him;
// repeated prods climb these five reactions and end with him turning his
// back. Durations are the gifs' own lengths — each plays exactly once.
const RANDY_POKES = [
  { sprite: "poke-1", ms: 840 },
  { sprite: "poke-2", ms: 760 },
  { sprite: "poke-3", ms: 940 },
  { sprite: "poke-4", ms: 1060 },
  { sprite: "poke-5", ms: 1820 },
];
const RANDY_POKE_RETURN_MS = 1680;
// Left alone this long, he forgets about it — and turns back around if he
// had his back to you.
const RANDY_POKE_CALM_MS = 4000;

let randyPokeLevel = 0;
let randyPokeAnim = null;
let randyPokeTurned = false;
let randyPokeAnimTimer = null;
let randyPokeCalmTimer = null;

/** True while he is reacting to a poke or sulking. */
function isRandyPoked() {
  return Boolean(randyPokeAnim || randyPokeTurned || randyPokeLevel > 0);
}

/**
 * Play a one-shot poke animation. The gifs loop, so the sprite is swapped
 * back out when its own duration elapses.
 */
function playPokeAnim(sprite, ms, after) {
  if (randyPokeAnimTimer) clearTimeout(randyPokeAnimTimer);
  randyPokeAnim = sprite;
  syncRandySprite();
  randyPokeAnimTimer = setTimeout(() => {
    randyPokeAnimTimer = null;
    randyPokeAnim = null;
    if (typeof after === "function") after();
    syncRandySprite();
  }, ms);
}

/** Restart the cool-off. Every poke pushes it back, so pestering keeps him cross. */
function randyScheduleCalmDown() {
  if (randyPokeCalmTimer) clearTimeout(randyPokeCalmTimer);
  randyPokeCalmTimer = setTimeout(() => {
    randyPokeCalmTimer = null;
    randyPokeLevel = 0;
    if (randyPokeTurned) {
      randyPokeTurned = false;
      playPokeAnim("poke-return", RANDY_POKE_RETURN_MS);
    } else {
      syncRandySprite();
    }
  }, RANDY_POKE_CALM_MS);
}

/**
 * Prod him. Only lands while he is out on the page — a click at the edge
 * summons him instead, and the menu belongs to the arrow.
 * @returns {boolean} true if the poke registered
 */
function randyPoke() {
  if (!isRandyOut()) return false;
  randyScheduleCalmDown();
  // Already turned away: further pokes just prolong the sulk.
  if (randyPokeTurned) return true;

  randyPokeLevel = Math.min(randyPokeLevel + 1, RANDY_POKES.length);
  const step = RANDY_POKES[randyPokeLevel - 1];
  playPokeAnim(step.sprite, step.ms, () => {
    if (randyPokeLevel >= RANDY_POKES.length) randyPokeTurned = true;
  });
  return true;
}

/** Wipe poke state — used when he leaves the page entirely. */
function randyResetPoke() {
  if (randyPokeAnimTimer) clearTimeout(randyPokeAnimTimer);
  if (randyPokeCalmTimer) clearTimeout(randyPokeCalmTimer);
  randyPokeAnimTimer = null;
  randyPokeCalmTimer = null;
  randyPokeAnim = null;
  randyPokeTurned = false;
  randyPokeLevel = 0;
}

/** Mirror the pose onto #randy so content.css can slide him to the edge. */
function applyRandyPoseAttr() {
  const randy = document.querySelector("#randy");
  if (randy) randy.dataset.pose = randyTransition || randyPose;
}

/** True while he is on the page rather than tucked behind the edge. */
function isRandyOut() {
  return randyPose === "out" && !randyTransition;
}

/**
 * Bring him out from the edge. No-op if he is already out or mid-jump.
 * @param {() => void} [after] - run once he has landed
 */
function randyComeOut(after) {
  if (randyPose === "out" || randyTransition) return;
  randyTransition = "jump-in";
  randyPose = "out";
  setRandyLog(true);
  applyRandyPoseAttr();
  syncRandySprite();
  setTimeout(() => {
    randyTransition = null;
    applyRandyPoseAttr();
    syncRandySprite();
    randyResetIdleRetreat();
    if (typeof after === "function") after();
  }, RANDY_JUMP_MS);
}

/** Send him back behind the edge, closing the menu on the way. */
function randyRetreat() {
  if (randyPose === "peek" || randyTransition) return;
  // Never walk off while the menu is open. The idle timer's busy check
  // already covers its own path, but retreat can be called from elsewhere,
  // and yanking the menu away mid-click is the worst version of this.
  if (typeof isMenuVisible === "function" && isMenuVisible()) return;
  randyResetPoke();
  if (typeof setMenuVisible === "function") setMenuVisible(false);
  if (typeof setArrowVisible === "function") setArrowVisible(false);
  randyTransition = "jump-out";
  randyPose = "peek";
  setRandyLog(false);
  applyRandyPoseAttr();
  syncRandySprite();
  setTimeout(() => {
    randyTransition = null;
    applyRandyPoseAttr();
    syncRandySprite();
  }, RANDY_JUMP_MS);
}

/**
 * Restart the retreat countdown. Called on any sign of life. If he is busy
 * when it fires the countdown simply restarts — retreating mid-sentence, or
 * out from under a pending question, is worse than overstaying.
 */
function randyResetIdleRetreat() {
  if (randyIdleTimer) {
    clearTimeout(randyIdleTimer);
    randyIdleTimer = null;
  }
  if (!isRandyOut()) return;
  randyIdleTimer = setTimeout(() => {
    randyIdleTimer = null;
    const busy =
      (typeof randyBubbleShowing === "function" && randyBubbleShowing()) ||
      (typeof window !== "undefined" && window.__randyPendingQuestion) ||
      (typeof isMenuVisible === "function" && isMenuVisible()) ||
      isRandyPoked() ||
      randyIsHovered;
    if (busy) {
      randyResetIdleRetreat();
      return;
    }
    randyRetreat();
  }, RANDY_IDLE_RETREAT_MS);
}

/**
 * Set Randy's mood. Roast persists past the reply so he sits there looking
 * smug; any other menu action returns him to normal.
 * @param {"normal"|"roast"} mood
 */
function setRandyMood(mood) {
  randyMood = mood === "roast" ? "roast" : "normal";
  syncRandySprite();
}

/**
 * Mark Randy as mid-sentence or not.
 * @param {boolean} speaking
 */
function setRandySpeaking(speaking) {
  randyIsSpeaking = Boolean(speaking);
  syncRandySprite();
}

// Speech pacing: a spoken-cadence estimate from the reply length, clamped so
// a one-word answer still gets a visible beat and a long one doesn't drone.
// ponytail: fixed rate — swap for a backend-supplied duration if replies ever
// carry one (e.g. TTS audio length).
const RANDY_MS_PER_CHAR = 30;
const RANDY_TALK_MIN_MS = 700;
const RANDY_TALK_MAX_MS = 6000;
let randyTalkTimer = null;

/**
 * How long Randy should mouth a given line, in ms.
 * @param {string} text
 * @returns {number} duration, or 0 when there is nothing to say
 */
function randyTalkDuration(text) {
  const len = typeof text === "string" ? text.trim().length : 0;
  if (!len) return 0;
  return Math.min(
    RANDY_TALK_MAX_MS,
    Math.max(RANDY_TALK_MIN_MS, len * RANDY_MS_PER_CHAR)
  );
}

/**
 * Talk for as long as `text` takes to say, then settle back to idle. Driven
 * from setBubbleText (bubble.js) — every line Randy says routes through
 * there, and each new one restarts the clock.
 * @param {string} text
 */
function randyTalkFor(text) {
  if (randyTalkTimer) {
    clearTimeout(randyTalkTimer);
    randyTalkTimer = null;
  }
  const ms = randyTalkDuration(text);
  if (!ms) {
    setRandySpeaking(false);
    return;
  }
  setRandySpeaking(true);
  randyTalkTimer = setTimeout(() => {
    randyTalkTimer = null;
    setRandySpeaking(false);
  }, ms);
}

/**
 * Cut a line short — used when the bubble is dismissed mid-sentence. Any
 * half-typed text is flushed so the reader never sees a truncated word.
 */
function randyStopTalking() {
  if (typeof randyFinishTyping === "function") randyFinishTyping();
  if (randyTalkTimer) {
    clearTimeout(randyTalkTimer);
    randyTalkTimer = null;
  }
  if (randyDismissTimer) {
    clearTimeout(randyDismissTimer);
    randyDismissTimer = null;
  }
  setRandySpeaking(false);
}

// How long a finished line stays readable before the bubble clears itself,
// mirroring the menu's hide grace period.
const RANDY_BUBBLE_LINGER_MS = 3000;
let randyDismissTimer = null;
let randyIsHovered = false;

/** Whether the bubble is currently on screen. */
function randyBubbleShowing() {
  const wrap = document.querySelector("#randy-bubble-wrap");
  return Boolean(wrap && wrap.style.display !== "none");
}

/**
 * Arm the self-dismiss countdown.
 * @param {number} ms
 */
function randyScheduleDismiss(ms) {
  if (randyDismissTimer) clearTimeout(randyDismissTimer);
  randyDismissTimer = setTimeout(() => {
    randyDismissTimer = null;
    // A pending "Did you apply?" must never time out from under the user.
    // Checked on fire rather than on schedule: the flag can be set after
    // the question text is rendered.
    if (typeof window !== "undefined" && window.__randyPendingQuestion) return;
    if (typeof setBubbleVisible === "function") setBubbleVisible(false);
  }, ms);
}

/** Hold the current line on screen while the cursor is on Randy. */
function randyPauseDismiss() {
  randyIsHovered = true;
  if (randyDismissTimer) {
    clearTimeout(randyDismissTimer);
    randyDismissTimer = null;
  }
}

/** Cursor left — give the reader the linger period, then clear the bubble. */
function randyResumeDismiss() {
  randyIsHovered = false;
  if (randyBubbleShowing()) {
    randyScheduleDismiss(RANDY_BUBBLE_LINGER_MS);
  }
}

/**
 * Say a line: animate the mouth for its length, then leave it on screen a
 * beat longer to read before the bubble clears itself. Called from
 * setBubbleText (bubble.js) — every line routes through there, and each new
 * one restarts both clocks.
 * @param {string} text
 */
function randySayLine(text) {
  randyStopTalking();

  const talkMs = randyTalkDuration(text);
  // Typing is driven from here so it shares one clock with the mouth: the
  // reveal is paced to finish inside talkMs. A zero duration (empty line)
  // just writes through and clears the bubble.
  if (typeof randyRevealText === "function") {
    randyRevealText(text, talkMs);
  }
  if (!talkMs) return;

  randyTalkFor(text);

  // While the cursor is on Randy the line is held open; mouseleave arms the
  // countdown instead.
  if (!randyIsHovered) {
    randyScheduleDismiss(talkMs + RANDY_BUBBLE_LINGER_MS);
  }
}

// ---------------------------------------------------------------------------
// Document delivery — cover letter & resume (no Blob / FileReader).
// The background service worker owns chrome.downloads.download() (MV3 safe).
// ---------------------------------------------------------------------------
const RANDY_COVER_LETTER_ORIGIN = (typeof BACKEND_URL !== "undefined" && BACKEND_URL ? BACKEND_URL : "http://127.0.0.1:5000").replace(/\/+$/, "");
const RANDY_COVER_LETTER_POLL_MS = 1000;
const RANDY_COVER_LETTER_TIMEOUT_MS = 30000;
// Resume reuses same origin/poll timings but hits /resumes endpoints
const RANDY_RESUME_ORIGIN = RANDY_COVER_LETTER_ORIGIN;
const RANDY_RESUME_POLL_MS = RANDY_COVER_LETTER_POLL_MS;
const RANDY_RESUME_TIMEOUT_MS = RANDY_COVER_LETTER_TIMEOUT_MS;

/**
 * Ask the background SW to poll status and trigger a silent download.
 * Falls back to direct fetch+poll if chrome.runtime is unavailable (e.g. orphaned).
 * @param {string} jobId
 * @returns {Promise<{ok:boolean, downloadId?:number, error?:string}>}
 */
function requestCoverLetterDownload(jobId) {
  if (!jobId) return Promise.resolve({ ok: false, error: "Missing jobId" });

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "poll-and-download-cover-letter", jobId }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "No response from background" });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || String(e) });
      }
    });
  }

  console.warn("[Randy] background unavailable, polling from content script");
  return pollCoverLetterThenDownloadFallback(jobId);
}

function requestResumeDownload(jobId) {
  if (!jobId) return Promise.resolve({ ok: false, error: "Missing jobId" });

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "poll-and-download-resume", jobId }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "No response from background" });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || String(e) });
      }
    });
  }

  console.warn("[Randy] background unavailable, polling resume from content script");
  return pollResumeThenDownloadFallback(jobId);
}

async function pollCoverLetterThenDownloadFallback(jobId) {
  const deadline = Date.now() + RANDY_COVER_LETTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${RANDY_COVER_LETTER_ORIGIN}/cover-letters/${jobId}/status`);
      if (r.status === 404) {
        const b = await r.json().catch(() => null);
        return { ok: false, error: b?.message || "Job expired" };
      }
      const data = await r.json().catch(() => null);
      if (data?.status === "ready") {
        window.open(`${RANDY_COVER_LETTER_ORIGIN}/cover-letters/${jobId}.pdf`, "_blank");
        return { ok: true };
      }
      if (data?.status === "error") return { ok: false, error: data.error || "Generation failed" };
    } catch (e) {
      console.warn("[Randy] fallback poll error:", e);
    }
    await new Promise((res) => setTimeout(res, RANDY_COVER_LETTER_POLL_MS));
  }
  return { ok: false, error: "Timed out waiting for cover letter" };
}

async function pollResumeThenDownloadFallback(jobId) {
  const deadline = Date.now() + RANDY_RESUME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${RANDY_RESUME_ORIGIN}/resumes/${jobId}/status`);
      if (r.status === 404) {
        const b = await r.json().catch(() => null);
        return { ok: false, error: b?.message || "Job expired" };
      }
      const data = await r.json().catch(() => null);
      if (data?.status === "ready") {
        window.open(`${RANDY_RESUME_ORIGIN}/resumes/${jobId}.pdf`, "_blank");
        return { ok: true };
      }
      if (data?.status === "error") return { ok: false, error: data.error || "Generation failed" };
    } catch (e) {
      console.warn("[Randy] fallback resume poll error:", e);
    }
    await new Promise((res) => setTimeout(res, RANDY_RESUME_POLL_MS));
  }
  return { ok: false, error: "Timed out waiting for resume" };
}

// Shared job payload helper — Handshake cache + DOM merge, used by both
// cover-letter and resume branches (same description source requirement).
async function getTailorJobPayload() {
  var hsEntry = null;
  try {
    hsEntry = typeof getHandshakeCachedJobForCurrentUrl === "function"
      ? getHandshakeCachedJobForCurrentUrl()
      : null;
  } catch (_hsCacheErr) {}
  var hsParsed = (hsEntry && hsEntry.parsed && typeof hsEntry.parsed === "object")
    ? hsEntry.parsed
    : null;
  var hsCompany = hsParsed && typeof hsParsed.company === "string" && hsParsed.company.trim()
    ? hsParsed.company.trim()
    : null;
  var hsTitle = hsParsed && typeof hsParsed.title === "string" && hsParsed.title.trim()
    ? hsParsed.title.trim()
    : null;
  var hsDescription = hsParsed && typeof hsParsed.description === "string" && hsParsed.description.trim()
    ? hsParsed.description
    : null;

  let job = null;
  var domJob = null;
  if (typeof scrapeCurrentJob === "function") {
    domJob = await scrapeCurrentJob({ report: false });
  }
  var domDescription = domJob && typeof domJob.description === "string" && domJob.description.trim()
    ? domJob.description
    : null;

  var isHandshakePage = (domJob && domJob.site === "handshake") || hsParsed;
  if (isHandshakePage) {
    job = {
      site: "handshake",
      jobId: (hsEntry && hsEntry.jobId) || (domJob && domJob.jobId) || null,
      company: hsCompany,
      title: hsTitle,
      description: hsDescription || domDescription,
    };
  } else {
    job = domJob;
  }
  return job;
}

async function getTailorPreferences() {
  if (typeof getRandyPreferences === "function") {
    try {
      return await getRandyPreferences();
    } catch (_) { return null; }
  }
  return null;
}

// Listen for download completion broadcasts from background SW to update bubble
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return false;
      if (msg.type === "cover_letter_download") {
        if (msg.status === "complete") {
          console.log(`[Randy] cover letter download complete (job ${msg.jobId})`);
          if (typeof setBubbleText === "function" && typeof setBubbleVisible === "function") {
            setBubbleVisible(true);
            setBubbleText("cover letter downloaded — check your downloads!");
            if (typeof setChoicesVisible === "function") setChoicesVisible(false);
          }
        } else if (msg.status === "interrupted" || msg.status === "error") {
          console.warn(`[Randy] cover letter download failed:`, msg);
          if (typeof setBubbleText === "function" && typeof setBubbleVisible === "function") {
            setBubbleVisible(true);
            setBubbleText(`download failed — ${msg.error || "interrupted"}. try again?`);
            if (typeof setChoicesVisible === "function") setChoicesVisible(false);
          }
        }
        return false;
      }
      if (msg.type === "resume_download") {
        if (msg.status === "complete") {
          console.log(`[Randy] resume download complete (job ${msg.jobId})`);
          if (typeof setBubbleText === "function" && typeof setBubbleVisible === "function") {
            setBubbleVisible(true);
            setBubbleText("resume downloaded — check your downloads!");
            if (typeof setChoicesVisible === "function") setChoicesVisible(false);
          }
        } else if (msg.status === "interrupted" || msg.status === "error") {
          console.warn(`[Randy] resume download failed:`, msg);
          if (typeof setBubbleText === "function" && typeof setBubbleVisible === "function") {
            setBubbleVisible(true);
            setBubbleText(`resume download failed — ${msg.error || "interrupted"}. try again?`);
            if (typeof setChoicesVisible === "function") setChoicesVisible(false);
          }
        }
        return false;
      }
      return false;
    });
  } catch (_) {}
}

function createRandy() {
  // Greenhouse runs with all_frames:true - only inject in top frame to avoid
  // hidden duplicate Randys inside iframes (which also appear to "disappear"
  // when the iframe navigates).
  if (typeof window !== "undefined" && window.top !== window.self) {
    return null;
  }
  // Guard against double-injection on LinkedIn SPA navigations.
  if (document.getElementById("randy")) {
    return document.getElementById("randy");
  }
  if (!document.body) {
    console.warn("[Randy] document.body not ready, deferring createRandy");
    return null;
  }

  const randy = document.createElement("div");
  randy.id = "randy";

  // Chat bubble lives in its own component (bubble.js / bubble.css).
  // Initial "..." is a loading placeholder only — the greeting text itself
  // always comes from the backend `reply` (session-scoped).
  const { wrap: bubbleWrap } = createBubble("");

  const character = document.createElement("img");
  character.id = "randy-character";
  // Only set src for real extension URLs — never chrome-extension://invalid/.
  if (RANDY_SPRITES[currentSprite]) {
    character.src = RANDY_SPRITES[currentSprite];
  }
  character.alt = "Randy the Otter";
  character.draggable = false;

  // If the gif fails to load (missing resource, CSP), keep the bubble usable
  // and don't permanently hide the otter — retry once with idle fallback.
  let spriteLoadRetried = false;
  character.addEventListener("error", () => {
    console.warn("[Randy] Failed to load sprite:", character.src);
    if (!spriteLoadRetried && RANDY_SPRITES.idle && character.src !== RANDY_SPRITES.idle) {
      spriteLoadRetried = true;
      character.src = RANDY_SPRITES.idle;
      return;
    }
    // Don't hide permanently — keeps #randy visible so ensureRandyExists
    // and future syncRandySprite can recover without a full re-inject.
    if (!character.src || character.src.includes("invalid")) {
      character.style.display = "none";
    }
  });

  // No greeting on page load: the bubble stays invisible until the backend
  // actually has a comment to make (random gate on ambient job sightings).
  // Yes/No answers POST { session_id, type: "answer", about_job }; reply
  // drives bubble. While a "Did you apply?" prompt is pending, the answer
  // carries the job identity so the backend can log it on "yes".
  async function handleRandyAnswer(answer) {
    if (typeof sendRandyEvent !== "function") {
      return;
    }
    const aboutJob =
      window.__randyPendingQuestion && typeof window.__randyPendingQuestion === "object"
        ? window.__randyPendingQuestion
        : undefined;
    try {
      const data = await sendRandyEvent("answer", { answer, about_job: aboutJob });
      if (typeof setBubbleFromBackend === "function") {
        setBubbleFromBackend(data);
      }
    } catch (error) {
      console.warn("[Randy] Answer send failed:", error);
    } finally {
      // Single question at a time — answering clears the pending slot and
      // lets the deferred dwell post for the new page fire (see watcher).
      window.__randyPendingQuestion = null;
      if (window.__randyPendingDwellUrl && typeof scrapeCurrentJob === "function") {
        const url = window.__randyPendingDwellUrl;
        window.__randyPendingDwellUrl = null;
        if (window.location.href === url) {
          scrapeCurrentJob().catch((e) => console.warn("[Randy] Deferred dwell failed:", e));
        }
      }
    }
  }

  // Click now just toggles the action menu (hover still opens it too).
  // No job message is forced on click — Roast owns that flow.
  // Yes/No buttons and menu items stopPropagation, so answering / picking
  // an action never retriggers this toggle.
  // On the character, not #randy: the container also covers the speech
  // bubble, the menu, and the invisible hover bridge, so a click anywhere
  // near him was poking him.
  character.addEventListener("click", () => {
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    // Tucked behind the edge, a click summons him out and does nothing else
    // — the menu belongs to the arrow, which only exists once he has landed.
    if (!isRandyOut()) {
      randyComeOut();
      return;
    }
    // Out on the page, a click is a poke. Opening the menu is the arrow's
    // job, so the otter's own click is free to be the playful gesture.
    randyResetIdleRetreat();
    randyPoke();
  });

  /**
   * Generic menu action handler:
   * - cover-letter: new path POST /cover-letters -> background SW downloads
   *   via chrome.downloads.download({saveAs:false}) — no Blob/anchor in content.
   * - roast / match-score: legacy POST /job-summary via sendRandyEvent.
   * While a "Did you apply?" question is pending the handler is suppressed.
   */
  async function handleMenuAction(action) {
    if (window.__randyPendingQuestion) {
      console.log(`[Randy] Menu action "${action}" suppressed while question pending`);
      if (typeof setMenuVisible === "function") {
        setMenuVisible(false);
      }
      return;
    }
    // Deliberately NOT closing the menu here. The reply appears in the
    // bubble while the menu stays up, so a second action is one click away
    // instead of a re-open. It closes on the arrow, or on the hover grace.
    // Roast is ambient now, never a menu action — picking anything from the
    // menu snaps him out of a smug idle back to normal.
    if (typeof setRandyMood === "function") {
      setRandyMood("normal");
    }

    // Track opens the applications tracker directly.
    if (action === "track") {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
        try {
          chrome.runtime.sendMessage({ type: "open-applications" }, () => {
            if (chrome.runtime.lastError) {
              console.warn("[Randy] open-applications failed:", chrome.runtime.lastError.message);
            }
          });
        } catch (e) {
          console.warn("[Randy] open-applications threw:", e);
        }
      }
      return;
    }

    const isCoverLetter = action === "cover-letter";
    const isResume = action === "resume";

    // Tailor children: dedicated endpoints + silent background download.
    // Both share the same Handshake+DOM merge and preferences forwarding.
    if (isCoverLetter || isResume) {
      const docLabel = isCoverLetter ? "cover letter" : "resume";
      if (typeof setBubbleVisible === "function") setBubbleVisible(true);
      if (typeof setBubbleText === "function") setBubbleText(`cooking your ${docLabel}...`);
      if (typeof setChoicesVisible === "function") setChoicesVisible(false);
      try {
        const job = typeof getTailorJobPayload === "function"
          ? await getTailorJobPayload()
          : null;
        console.log(`[Randy] ${docLabel} job source:`, job);
        const description = job && typeof job.description === "string" ? job.description : null;
        if (!description || !description.trim()) {
          if (typeof setBubbleText === "function") setBubbleText(`no description on this one — can't cook a ${docLabel}`);
          return;
        }
        const sessionId = typeof getRandySessionId === "function" ? getRandySessionId() : "default";
        const preferences = typeof getTailorPreferences === "function" ? await getTailorPreferences() : null;
        const endpoint = isCoverLetter ? "cover-letters" : "resumes";
        const origin = isCoverLetter ? RANDY_COVER_LETTER_ORIGIN : RANDY_RESUME_ORIGIN;
        const createResp = await fetch(`${origin}/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, description, job, preferences }),
        });
        const createBody = await createResp.json().catch(() => null);
        if (!createResp.ok) {
          const msg = createBody?.message || `Server ${createResp.status}`;
          throw new Error(msg);
        }
        const jobId = createBody && createBody.job_id;
        if (!jobId) throw new Error("No job_id returned");
        console.log(`[Randy] ${docLabel} job created: ${jobId}`);

        if (typeof setBubbleText === "function") setBubbleText(`${docLabel}'s cooking... will download automatically when ready`);

        const dlResult = isCoverLetter
          ? await requestCoverLetterDownload(jobId)
          : await requestResumeDownload(jobId);
        if (!dlResult.ok) {
          const err = dlResult.error || "download failed";
          if (/expired|not found|404/i.test(err)) {
            if (typeof setBubbleText === "function") setBubbleText(`that ${docLabel} expired — try ${docLabel} again?`);
          } else if (/timed out/i.test(err)) {
            if (typeof setBubbleText === "function") setBubbleText("taking a while — try again in a sec?");
          } else {
            if (typeof setBubbleText === "function") setBubbleText(`something broke — ${err}`);
          }
          console.warn(`[Randy] ${docLabel} download error:`, dlResult);
          return;
        }
        if (typeof setBubbleText === "function") setBubbleText(`downloading your ${docLabel}...`);
      } catch (error) {
        console.warn(`[Randy] ${docLabel} failed:`, error);
        if (typeof setBubbleText === "function") {
          const msg = error && error.message ? error.message : String(error);
          if (/expired/i.test(msg)) setBubbleText(`that ${docLabel} expired — try again?`);
          else setBubbleText(`${docLabel} failed — ${msg}`);
        }
      }
      return;
    }

    // Non-cover-letter actions: legacy job-summary path
    if (typeof setBubbleVisible === "function") {
      setBubbleVisible(true);
    }
    if (typeof setBubbleLoading === "function") {
      setBubbleLoading();
    } else {
      setBubbleText("...");
    }
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

  // Behind Randy in paint order — he stands on top of it.
  const log = document.createElement("img");
  log.id = "randy-log";
  log.alt = "";
  log.draggable = false;
  log.style.display = "none";

  randy.appendChild(bubbleWrap);
  randy.appendChild(log);
  randy.appendChild(character);
  document.body.appendChild(randy);

  // Resting state: peeking in from the edge. Set after mount so the pose
  // attribute and sprite agree from the first paint.
  applyRandyPoseAttr();
  syncRandySprite();

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

  // Hover only reveals the arrow now; opening the menu takes a deliberate
  // click on it. The otter sits where the cursor travels, so hover-to-open
  // fired constantly by accident.
  const HOVER_ARROW_DELAY_MS = 0;
  // Grace period before the arrow (and any open menu) goes away after the
  // mouse leaves. Covers the gap between Randy and the fanned-out items,
  // which belongs to neither element — crossing it fires mouseleave.
  const HOVER_MENU_HIDE_DELAY_MS = 1200;
  // An open menu was a deliberate click, so it gets far longer before it
  // packs itself away — drifting off it for a moment, or reading a reply in
  // the bubble, should not cost you the menu you just opened.
  const HOVER_MENU_OPEN_HIDE_MS = 12000;
  randy.addEventListener("mouseenter", () => {
    randyPauseDismiss();
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (window.__randyMenuHideTimer) {
      clearTimeout(window.__randyMenuHideTimer);
      window.__randyMenuHideTimer = null;
    }
    randyResetIdleRetreat();
    window.__randyHoverTimer = setTimeout(() => {
      window.__randyHoverTimer = null;
      // No arrow while he is peeking — there is nothing to point at yet.
      if (isRandyOut() && typeof setArrowVisible === "function") {
        setArrowVisible(true);
      }
    }, HOVER_ARROW_DELAY_MS);
  });
  randy.addEventListener("mouseleave", () => {
    randyResumeDismiss();
    if (window.__randyHoverTimer) {
      clearTimeout(window.__randyHoverTimer);
      window.__randyHoverTimer = null;
    }
    if (window.__randyMenuHideTimer) {
      clearTimeout(window.__randyMenuHideTimer);
    }
    const menuWasOpen =
      typeof isMenuVisible === "function" && isMenuVisible();
    window.__randyMenuHideTimer = setTimeout(() => {
      window.__randyMenuHideTimer = null;

      // Confirm the pointer really left before tearing anything down.
      // mouseleave fires spuriously here — a layout shift under a
      // stationary cursor is enough — and acting on it made the chevron
      // vanish a moment after appearing. :hover is the browser's own
      // answer and covers #randy plus every descendant, so it holds
      // whatever generated the stray event.
      try {
        if (randy.matches(":hover")) {
          randyResetIdleRetreat();
          return;
        }
      } catch (_) {
        // :hover unsupported in some contexts — fall through and hide.
      }

      // Retract the items first, then take the arrow with them.
      if (typeof setMenuVisible === "function") {
        setMenuVisible(false);
      }
      if (typeof setArrowVisible === "function") {
        setArrowVisible(false);
      }
      // Leaving restarts the retreat countdown from now.
      randyResetIdleRetreat();
    }, menuWasOpen ? HOVER_MENU_OPEN_HIDE_MS : HOVER_MENU_HIDE_DELAY_MS);
  });

  return randy;
}

createRandy();

// Keep Randy alive across SPA body rewrites (Greenhouse/LinkedIn sometimes
// replace innerHTML which detaches #randy). Re-inject if removed.
(function keepRandyAlive() {
  if (typeof window !== "undefined" && window.top !== window.self) return;
  if (window.__randyKeepAliveObserver) return;
  const observer = new MutationObserver(() => {
    if (!document.body) return;
    if (!document.getElementById("randy") || !document.getElementById("randy-character")) {
      // Debounce — body rewrites fire many mutations at once
      if (window.__randyKeepAliveScheduled) return;
      window.__randyKeepAliveScheduled = true;
      setTimeout(() => {
        window.__randyKeepAliveScheduled = false;
        if ((!document.getElementById("randy") || !document.getElementById("randy-character")) && document.body) {
          console.log("[Randy] Re-injecting after DOM detach");
          createRandy();
        }
      }, 250);
    }
  });
  // Watch documentElement so body replacement is also caught; body childList
  // covers direct #randy removal. Use subtree:true but debounced so cheap.
  const target = document.documentElement || document.body;
  if (target) observer.observe(target, { childList: true, subtree: true });
  window.__randyKeepAliveObserver = observer;
})();

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
      const previousJob = window.__randyLastJob;
      const previousUrl = window.__randyLastJobUrl;
      lastUrl = window.location.href;
      // One conversation at a time: if a "Did you apply?" is already pending,
      // don't fire the dwell comment for the new page yet — defer it until
      // the user answers (see handleRandyAnswer's finally block).
      const hasPending = Boolean(window.__randyPendingQuestion);
      // Fire the dwell scrape for the new page unless we're mid-question.
      if (!hasPending) {
        schedule();
      } else {
        // Remember where we are so the deferred post can still fire later.
        window.__randyPendingDwellUrl = lastUrl;
      }
      // Ask about the posting just left, once per (source, job_id) session.
      if (
        previousJob &&
        previousJob.jobId &&
        previousUrl !== lastUrl &&
        typeof sendRandyEvent === "function" &&
        typeof setBubbleFromBackend === "function"
      ) {
        const key =
          typeof randyJobKey === "function"
            ? randyJobKey(previousJob.site || previousJob.source, previousJob.jobId)
            : null;
        const askedSet = window.__randyAskedJobs || (window.__randyAskedJobs = new Set());
        // Only ask when we have a stable identity to log; otherwise the
        // yes/no buttons can't usefully record anything.
        if (key && !askedSet.has(key)) {
          askedSet.add(key);
          // Handshake title/company may have landed in the interceptor
          // cache after the scrape — fill gaps best-effort so the
          // tracker row isn't left blank.
          let captureTitle = previousJob.title || null;
          let captureCompany = previousJob.company || null;
          if ((!captureTitle || !captureCompany) && typeof getHandshakeCachedJobForCurrentUrl === "function") {
            try {
              const hsEntry = getHandshakeCachedJobForCurrentUrl();
              const hsParsed = hsEntry && hsEntry.parsed;
              if (hsParsed && typeof hsParsed === "object") {
                if (!captureTitle && typeof hsParsed.title === "string" && hsParsed.title.trim()) {
                  captureTitle = hsParsed.title.trim();
                }
                if (!captureCompany && typeof hsParsed.company === "string" && hsParsed.company.trim()) {
                  captureCompany = hsParsed.company.trim();
                }
              }
            } catch (_e) {}
          }
          const capture = {
            source: previousJob.site || previousJob.source || null,
            job_id: previousJob.jobId,
            jobId: previousJob.jobId,
            site: previousJob.site || previousJob.source || null,
            title: captureTitle,
            company: captureCompany,
          };
          // Replace any pending question — latest switch wins.
          window.__randyPendingQuestion = capture;
          sendRandyEvent("job-switch", { previous_job: capture })
            .then((data) => {
              // Don't render stale asks (overwritten by a faster subsequent
              // switch). The latest switch's pending capture is authoritative.
              if (window.__randyPendingQuestion !== capture) return;
              setBubbleFromBackend(data);
            })
            .catch((error) => {
              console.warn("[Randy] job-switch failed:", error);
            });
        } else if (!key) {
          console.warn("[Randy] Skipping applied prompt — no job identity:", previousJob);
        }
      }
    }
  }, 500);
})();

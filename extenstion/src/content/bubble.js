/* Randy chat bubble component.
 *
 * Owns the bubble DOM and the text API. Randy container/gif logic
 * lives in content.js.
 *
 * Structure:
 *   #randy-bubble-wrap (positions the tail, sizes the bubble)
 *     #randy-bubble-frame (black, pixel-clipped border)
 *       #randy-bubble      (white face, same pixel clip)
 *     #randy-bubble-tail (black stepped tail, SIBLING of the frame)
 *       #randy-bubble-tail-face (white inset)
 *     #randy-choices (Yes/No buttons, sibling — never clipped)
 *
 * The tail must NOT live inside the frame: clip-path on the frame
 * clips all of its descendants, so an overhanging tail child gets
 * sliced off. As a sibling inside the unclipped wrap it renders fully.
 * Same rule applies to the choice buttons.
 */

function createMatchBox() {
  const box = document.createElement("div");
  box.id = "randy-match-box";
  box.style.display = "none";

  const frame = document.createElement("div");
  frame.id = "randy-match-box-frame";

  const inner = document.createElement("div");
  inner.id = "randy-match-box-inner";
  frame.appendChild(inner);
  box.appendChild(frame);
  return box;
}

function createBubble(initialText) {
  const wrap = document.createElement("div");
  wrap.id = "randy-bubble-wrap";
  // Invisible until the backend says to show it (see setBubbleFromBackend).
  // Randy only pops up when he actually has a comment to make.
  wrap.style.display = "none";

  const matchBox = createMatchBox();

  const frame = document.createElement("div");
  frame.id = "randy-bubble-frame";

  const bubble = document.createElement("div");
  bubble.id = "randy-bubble";
  bubble.textContent = initialText ?? "";

  const tail = document.createElement("div");
  tail.id = "randy-bubble-tail";

  const tailFace = document.createElement("div");
  tailFace.id = "randy-bubble-tail-face";

  tail.appendChild(tailFace);
  frame.appendChild(bubble);
  wrap.appendChild(matchBox);
  wrap.appendChild(frame);
  wrap.appendChild(tail);

  return { wrap, frame, bubble, matchBox };
}

/**
 * Update the speech bubble text. Bubble width stays capped at
 * Randy's own width via CSS (max-width: var(--randy-size)) and
 * grows vertically instead.
 * @param {string} text - text to show in the bubble (must come from backend `reply`)
 */
let randyTypeTimer = null;
let randyTypeFull = "";

// A roast lands better if the face gets there first — the smug sprite shows,
// then the line arrives a beat later. It's the reaction-before-dialogue cut,
// and it reads as him thinking of the burn rather than reciting it. Only
// roasts get the pause; ordinary replies stay immediate.
const RANDY_ROAST_LEAD_MS = 200;
// Length of the exit dissolve in bubble.css. Must match it — the wrap can
// only be hidden once the blocks have finished scattering.
const RANDY_BUBBLE_FADE_MS = 200;
let randyBubbleHideTimer = null;
let randyRoastLeadTimer = null;

/** Drop a scheduled roast line (superseded, or the bubble was dismissed). */
function cancelRoastLead() {
  if (randyRoastLeadTimer) {
    clearTimeout(randyRoastLeadTimer);
    randyRoastLeadTimer = null;
  }
}

/**
 * Reveal `text` a character at a time, finishing within `totalMs`.
 *
 * The untyped remainder stays in the DOM as hidden text rather than being
 * left out, so the bubble is its final size from the first frame. Appending
 * character by character would reflow the box on every tick and make the
 * tail jitter under it.
 *
 * @param {string} text
 * @param {number} totalMs - the mouth animation's length; typing never
 *   outruns it, so the two finish together on long lines
 */
function randyRevealText(text, totalMs) {
  const bubble = document.querySelector("#randy-bubble");
  if (!bubble) return;

  if (randyTypeTimer) {
    clearInterval(randyTypeTimer);
    randyTypeTimer = null;
  }

  const full = typeof text === "string" ? text : "";
  randyTypeFull = full;
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!full || reduced || !totalMs) {
    bubble.textContent = full;
    return;
  }

  const paint = (n) => {
    bubble.textContent = "";
    bubble.appendChild(document.createTextNode(full.slice(0, n)));
    const rest = document.createElement("span");
    // Occupies its space but stays invisible — this is what holds the box
    // at its final size.
    rest.style.visibility = "hidden";
    rest.textContent = full.slice(n);
    bubble.appendChild(rest);
  };

  // Natural cadence, but compressed if the line is long enough that typing
  // at full speed would outlast the mouth. The cap is the same rate that
  // sizes the mouth animation (content.js), read at call time rather than
  // duplicated — two copies would silently drift apart and desync the two.
  const perChar =
    typeof RANDY_MS_PER_CHAR === "number" ? RANDY_MS_PER_CHAR : 40;
  const step = Math.max(16, Math.min(perChar, totalMs / full.length));
  let shown = 0;
  paint(0);
  randyTypeTimer = setInterval(() => {
    shown += 1;
    if (shown >= full.length) {
      clearInterval(randyTypeTimer);
      randyTypeTimer = null;
      bubble.textContent = full;
      return;
    }
    paint(shown);
  }, step);
}

/**
 * Show the thinking indicator instead of text.
 *
 * Deliberately not routed through setBubbleText: a loading state should not
 * type out, should not move his mouth (he is thinking, not talking), and
 * must not start the auto-dismiss countdown — a reply can easily take longer
 * than the ~3s a short line would linger for, and the bubble vanishing
 * before the answer arrives is worse than it overstaying.
 */
/* ---------------------------------------------------------------------------
 * Match-score pixel box — shows above the bubble when backend returns
 * structured `match_score` (answer outside, works/misses + bars inside).
 * Pixel philosophy: same clip-path stepped corners as the bubble.
 * ------------------------------------------------------------------------ */
function getMatchBox() {
  return document.querySelector("#randy-match-box");
}
function getMatchBoxInner() {
  return document.querySelector("#randy-match-box-inner");
}
function setMatchBoxVisible(visible) {
  const box = getMatchBox();
  if (!box) return;
  box.style.display = visible ? "" : "none";
}
function clearMatchBox() {
  const inner = getMatchBoxInner();
  if (inner) inner.textContent = "";
  setMatchBoxVisible(false);
}
function setBubbleFrameVisible(visible) {
  const frame = document.querySelector("#randy-bubble-frame");
  const tail = document.querySelector("#randy-bubble-tail");
  const box = getMatchBox();
  if (frame) frame.style.display = visible ? "" : "none";
  if (tail) tail.style.display = visible ? "" : "none";
  if (box) box.style.marginBottom = visible ? "" : "0";
}
function renderMatchBox(ms) {
  const box = getMatchBox();
  const inner = getMatchBoxInner();
  if (!box || !inner || !ms || typeof ms !== "object") return false;
  const avg = typeof ms.avg_score === "number" ? ms.avg_score : 0;
  const pref = typeof ms.preferences_score === "number" ? ms.preferences_score : 0;
  const qual = typeof ms.qualifications_score === "number" ? ms.qualifications_score : 0;
  const works = Array.isArray(ms.works) ? ms.works.slice(0, 3) : [];
  const misses = Array.isArray(ms.misses) ? ms.misses.slice(0, 3) : [];
  if (!works.length && !misses.length) return false;

  inner.textContent = "";

  // Avg as one fixed pixel semicircle. Its grid-aligned path runs clockwise
  // from the left endpoint, over the top, to the right endpoint.
  const getTier = (val) => (val >= 75 ? "high" : val >= 45 ? "mid" : "low");
  const tier = getTier(avg);
  const meter = document.createElement("div");
  meter.className = "randy-avg-meter";
  meter.dataset.tier = tier;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 60");
  svg.setAttribute("class", "randy-avg-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("shape-rendering", "crispEdges");
  const clampedAvg = Math.max(0, Math.min(100, avg));
  const ringPath = "M10 52V40H12V34H14V30H16V26H18V22H22V18H26V16H30V14H36V12H42V10H58V12H64V14H70V16H74V18H78V22H82V26H84V30H86V34H88V40H90V52";
  const outline = document.createElementNS(svgNS, "path");
  outline.setAttribute("d", ringPath);
  outline.setAttribute("class", "randy-avg-ring randy-avg-ring-outline");
  outline.setAttribute("pathLength", "100");
  const track = document.createElementNS(svgNS, "path");
  track.setAttribute("d", ringPath);
  track.setAttribute("class", "randy-avg-ring randy-avg-ring-track");
  track.setAttribute("pathLength", "100");
  const fill = document.createElementNS(svgNS, "path");
  fill.setAttribute("d", ringPath);
  fill.setAttribute("class", "randy-avg-ring randy-avg-ring-fill");
  fill.setAttribute("pathLength", "100");
  fill.setAttribute("stroke-dasharray", `${clampedAvg} 100`);
  const value = document.createElementNS(svgNS, "text");
  value.setAttribute("class", "randy-avg-svg-val");
  value.setAttribute("x", "50");
  value.setAttribute("y", "49");
  value.setAttribute("text-anchor", "middle");
  value.textContent = avg + "%";
  svg.append(outline, track, fill, value);
  const labelEl = document.createElement("div");
  labelEl.className = "randy-avg-label";
  labelEl.textContent = "avg";
  meter.append(svg, labelEl);
  inner.appendChild(meter);

  // Sub-scores — prefs / quals remain as before (same bar layout)
  const scores = document.createElement("div");
  scores.className = "randy-match-scores";
  const mkRow = (label, val) => {
    const row = document.createElement("div");
    row.className = "randy-score";
    const l = document.createElement("span");
    l.className = "randy-score-label";
    l.textContent = label;
    const bar = document.createElement("div");
    bar.className = "randy-score-bar";
    const fill = document.createElement("div");
    fill.className = "randy-score-fill";
    fill.style.width = Math.max(0, Math.min(100, val)) + "%";
    bar.appendChild(fill);
    const v = document.createElement("span");
    v.className = "randy-score-val";
    v.textContent = val + "%";
    row.append(l, bar, v);
    if (val >= 75) row.dataset.tier = "high";
    else if (val >= 45) row.dataset.tier = "mid";
    else row.dataset.tier = "low";
    return row;
  };
  scores.append(mkRow("prefs", pref), mkRow("quals", qual));
  inner.appendChild(scores);

  // Two columns: works | misses
  const cols = document.createElement("div");
  cols.className = "randy-match-cols";

  const mkCol = (head, items, cls) => {
    const col = document.createElement("div");
    col.className = "randy-match-col " + cls;
    const h = document.createElement("div");
    h.className = "randy-match-col-head";
    h.textContent = head;
    const ul = document.createElement("ul");
    ul.className = "randy-match-list";
    items.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = String(t).toLowerCase();
      ul.appendChild(li);
    });
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "randy-match-empty";
      li.textContent = "—";
      ul.appendChild(li);
    }
    col.append(h, ul);
    return col;
  };
  cols.append(mkCol("works", works, "randy-match-works"), mkCol("misses", misses, "randy-match-misses"));
  inner.appendChild(cols);

  setMatchBoxVisible(true);
  return true;
}

function setBubbleLoading() {
  const bubble = document.querySelector("#randy-bubble");
  if (!bubble) return;

  // Loading replaces match box as well — stale works/misses must not linger.
  clearMatchBox();
  setBubbleFrameVisible(true);

  // Cancels the typewriter, the mouth, and any pending dismissal.
  if (typeof randyStopTalking === "function") randyStopTalking();
  if (randyTypeTimer) {
    clearInterval(randyTypeTimer);
    randyTypeTimer = null;
  }

  bubble.textContent = "";
  const box = document.createElement("div");
  box.id = "randy-bubble-loading";
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement("span");
    dot.className = "randy-dot";
    box.appendChild(dot);
  }
  bubble.appendChild(box);
}

/** Drop the typewriter and show the whole line at once. */
function randyFinishTyping() {
  if (!randyTypeTimer) return;
  clearInterval(randyTypeTimer);
  randyTypeTimer = null;
  const bubble = document.querySelector("#randy-bubble");
  if (bubble) bubble.textContent = randyTypeFull;
}

function setBubbleText(text) {
  const bubble = document.querySelector("#randy-bubble");
  const wrap = document.querySelector("#randy-bubble-wrap");
  if (!bubble) return;
  // A new line re-shows the bubble unconditionally: it may have dismissed
  // since the last one (e.g. between cover-letter progress updates), or be
  // mid-dissolve right now — checking for display:none would miss that and
  // let the pending hide fire over the new text.
  if (text && wrap) {
    setBubbleVisible(true);
  }
  // randySayLine owns the timing for all three things that have to agree:
  // the mouth animation, the typewriter, and how long the bubble lingers.
  // Lives in content.js, which loads after this file.
  if (typeof randySayLine === "function") {
    randySayLine(text);
  } else {
    bubble.textContent = text;
  }
}

/**
 * Show or hide the Yes/No choice buttons. Hidden by default — the backend
 * `is_question` flag drives visibility via setBubbleFromBackend().
 * @param {boolean} visible - true to show, false to hide
 */
function setChoicesVisible(visible) {
  const choices = document.querySelector("#randy-choices");
  if (choices) {
    choices.style.display = visible ? "" : "none";
  }
}

/**
 * Show or hide the whole chat bubble. The bubble stays invisible unless
 * the backend sets `show: true` on its reply — ambient job sightings only
 * pop Randy up when he actually comments.
 * @param {boolean} visible - true to bring up the bubble, false to hide it
 */
function setBubbleVisible(visible) {
  const wrap = document.querySelector("#randy-bubble-wrap");
  if (!wrap) return;

  if (randyBubbleHideTimer) {
    clearTimeout(randyBubbleHideTimer);
    randyBubbleHideTimer = null;
  }

  if (visible) {
    // Clearing the state also rescues a bubble caught mid-dissolve.
    wrap.removeAttribute("data-state");
    wrap.style.display = "";
    // Restores bubble frame for normal (non-match) replies. Match path hides
    // it again immediately after, so net effect is frame hidden only for match.
    setBubbleFrameVisible(true);
    return;
  }

  if (wrap.style.display === "none") return;

  // Hiding also hides the match box (it lives above the bubble and should dissolve together)
  clearMatchBox();

  // Hiding cuts him off mid-sentence, and drops a roast still waiting on its
  // lead — otherwise it would pop the bubble back open after dismissal.
  cancelRoastLead();
  if (typeof randyStopTalking === "function") randyStopTalking();

  // Restart dance: both states drive the same animation-name, so swapping
  // the attribute alone retargets a finished animation and it snaps.
  wrap.removeAttribute("data-state");
  void wrap.offsetWidth;
  wrap.setAttribute("data-state", "closing");
  randyBubbleHideTimer = setTimeout(() => {
    randyBubbleHideTimer = null;
    wrap.style.display = "none";
    wrap.removeAttribute("data-state");
    // Only now has the line really gone, so drop the attentive pose back to
    // the resting one. Nothing else re-syncs after this point.
    if (typeof syncRandySprite === "function") syncRandySprite();
  }, RANDY_BUBBLE_FADE_MS);
}

/**
 * Render a backend response: bubble text from `reply`, bubble visibility
 * from `show`, plus Yes/No visibility from `is_question`.
 *
 * Stale guard: responses carry the send-order tag `__randySeq`
 * (see postRandyEnvelope). A response older than the newest one already
 * rendered is dropped, so a slow earlier request can never overwrite a
 * newer message. Null (failed request) carries no new information and is
 * a no-op — it must not clobber fresh UI either.
 *
 * When the backend declines to comment (`show` not strictly true — the
 * random gate for ambient job sightings), the bubble is hidden and nothing
 * renders.
 * @param {object|null} data - backend JSON with `reply` / `show` / `is_question`
 * @returns {boolean} true when a reply was rendered
 */
/**
 * Whether a "Did you apply?" question is currently awaiting an answer.
 * While true the question has absolute priority — nothing may overwrite it.
 * @returns {boolean}
 */
function isQuestionPending() {
  return typeof window !== "undefined" && Boolean(window.__randyPendingQuestion);
}

function setBubbleFromBackend(data) {
  if (!data || typeof data !== "object") {
    return false;
  }
  // Highest priority: while a question is pending, only the question
  // itself (job-switch) and its answer may touch the bubble. Everything
  // else is suppressed and must NOT advance the stale seq, otherwise the
  // answer ack would be dropped as stale.
  if (isQuestionPending()) {
    const echoType = data.echo && data.echo.type;
    const allowed = echoType === "job-switch" || echoType === "answer";
    if (!allowed) {
      console.log(`[Randy] Suppressing ${echoType || "unknown"} reply while question pending`);
      return false;
    }
  }
  if (typeof data.__randySeq === "number") {
    const lastRendered =
      typeof window !== "undefined" &&
      typeof window.__randyRenderedSeq === "number"
        ? window.__randyRenderedSeq
        : 0;
    if (data.__randySeq < lastRendered) {
      console.log(
        `[Randy] Dropping stale backend reply (seq ${data.__randySeq} < ${lastRendered})`
      );
      return false;
    }
    if (typeof window !== "undefined") {
      window.__randyRenderedSeq = data.__randySeq;
    }
  }
  // This reply supersedes anything still waiting on a lead.
  cancelRoastLead();

  if (data.show !== true) {
    // Never hide the bubble while a question is pending — the prompt must
    // stay on screen until answered, no matter what the backend gated.
    if (isQuestionPending()) {
      return false;
    }
    setBubbleVisible(false);
    return false;
  }
  // Mood before text: randySayLine picks the sprite when the line starts, so
  // setting this afterwards would show a normal mouth for the first frames of
  // a roast and then snap. The backend sets `roast` on ambient roast replies.
  if (typeof setRandyMood === "function") {
    setRandyMood(data.roast === true ? "roast" : "normal");
  }

  const render = () => {
    setBubbleVisible(true);
    setChoicesVisible(data.is_question === true);
    // Structured match-score: show only the pixel box, hide the speech bubble entirely.
    // Top panel background is white (#fff) and gap collapses when bubble is gone.
    const ms = typeof getRandyMatchScore === "function" ? getRandyMatchScore(data) : null;
    if (ms) {
      renderMatchBox(ms);
      setBubbleFrameVisible(false);
      // Hide bubble answer entirely — clear stale text/typing and stop mouth.
      const bubble = document.querySelector("#randy-bubble");
      if (bubble) bubble.textContent = "";
      if (typeof randyStopTalking === "function") randyStopTalking();
      cancelRoastLead();
      if (randyTypeTimer) {
        clearInterval(randyTypeTimer);
        randyTypeTimer = null;
      }
      return true;
    } else {
      clearMatchBox();
      setBubbleFrameVisible(true);
    }
    const reply =
      typeof getRandyReply === "function" ? getRandyReply(data) : null;
    if (reply) {
      setBubbleText(reply);
      return true;
    }
    return false;
  };

  // The mood is already applied above, so during this pause he is sitting in
  // the smug idle sprite with no bubble yet.
  if (data.roast === true) {
    randyRoastLeadTimer = setTimeout(() => {
      randyRoastLeadTimer = null;
      render();
    }, RANDY_ROAST_LEAD_MS);
    return true;
  }

  return render();
}

/**
 * Attach Yes/No choice buttons under the bubble. Callbacks receive
 * "yes" or "no" — content.js POSTs { session_id, type: "answer" }.
 * Buttons stopPropagation so the bubble click handler doesn't fire.
 * @param {(answer: "yes" | "no") => void} onAnswer
 * @returns {HTMLElement|null} choices element or null when wrap missing
 */
function createChoiceButtons(onAnswer) {
  const wrap = document.querySelector("#randy-bubble-wrap");
  if (!wrap || document.querySelector("#randy-choices")) {
    return document.querySelector("#randy-choices");
  }
  const choices = document.createElement("div");
  choices.id = "randy-choices";
  // Hidden until a backend reply sets is_question: true.
  choices.style.display = "none";

  for (const answer of ["yes", "no"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "randy-choice";
    btn.dataset.answer = answer;
    btn.textContent = answer === "yes" ? "YES" : "NO";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof onAnswer === "function") {
        onAnswer(answer);
      }
    });
    choices.appendChild(btn);
  }

  wrap.appendChild(choices);
  return choices;
}

/* Randy hover menu component.
 *
 * A side panel of stub actions that appears after hovering Randy for >1s.
 * Actions are NOT wired to any function yet — clicks only console.log.
 * Each action id is the future hook point for its real implementation.
 *
 * Structure (built by createMenu, appended inside #randy):
 *   #randy-menu (absolutely positioned left of the character, menu.css)
 *     .randy-menu-item[data-action="roast"]
 *     .randy-menu-item[data-action="cover-letter"]
 *     .randy-menu-item[data-action="match-score"]
 *
 * Like the Yes/No choice buttons, menu clicks stopPropagation so they never
 * retrigger the poke handler living on the #randy container (content.js).
 */

// Action registry: id is the stable hook, label is shown. The ids are
// load-bearing — content.js keys the roast sprite off them, and the backend
// routes on EXPLICIT_TRIGGERS / the "[action: <id>]" orchestrator tag — so
// relabel freely but leave the ids alone.
// Roast is deliberately absent: it now fires ambiently while you browse
// (see ROAST_PROBABILITY in jobs_controller.py) rather than on demand.
// "cover-letter" (label Tailor) is now a parent toggle — its children live in
// RANDY_TAILOR_ACTIONS and fan left of it (see createMenu). Children use
// distinct ids so content.js can route to /cover-letters vs /resumes.
const RANDY_MENU_ACTIONS = [
  { id: "match-score", label: "Match" },
  { id: "track", label: "Track" },
  { id: "cover-letter", label: "Tailor" },
];

const RANDY_TAILOR_ACTIONS = [
  { id: "cover-letter", label: "Cover Letter" },
  { id: "resume", label: "Resume" },
];

// Length of the level dissolve in menu.css. Must match it — a level can
// only be hidden once its blocks have finished scattering.
const RANDY_MENU_ANIM_MS = 220;
const RANDY_ARROW_ANIM_MS = 200;
let randyArrowHideTimer = null;
let randyLevelHideTimer = null;

// One source of truth for how deep the menu is open: 0 closed, 1 the three
// actions, 2 the Tailor children. Two independent booleans let the levels
// disagree — both open at once, or the arrow flipped with nothing showing.
let randyMenuDepth = 0;

const RANDY_MENU_LEVELS = {
  1: "#randy-menu",
  2: "#randy-tailor-submenu",
};

/**
 * Show or hide the arrow. Revealing it is the only thing hover does —
 * hover-to-open fired by accident constantly, since the otter sits exactly
 * where the cursor travels.
 * @param {boolean} visible
 */
function setArrowVisible(visible) {
  const arrow = document.querySelector("#randy-menu-arrow");
  if (!arrow) return;

  if (randyArrowHideTimer) {
    clearTimeout(randyArrowHideTimer);
    randyArrowHideTimer = null;
  }

  if (visible) {
    arrow.removeAttribute("data-state");
    arrow.style.display = "block";
    // Reflow so a re-show replays the dissolve rather than retargeting the
    // finished one.
    void arrow.offsetWidth;
    arrow.setAttribute("data-state", "in");
    return;
  }

  if (arrow.style.display !== "block") return;

  arrow.removeAttribute("data-state");
  void arrow.offsetWidth;
  arrow.setAttribute("data-state", "out");
  randyArrowHideTimer = setTimeout(() => {
    randyArrowHideTimer = null;
    arrow.style.display = "none";
    arrow.removeAttribute("data-state");
  }, RANDY_ARROW_ANIM_MS);
}

/** Whether the arrow is currently on screen. */
function isArrowVisible() {
  const arrow = document.querySelector("#randy-menu-arrow");
  return Boolean(
    arrow &&
      arrow.style.display === "block" &&
      arrow.getAttribute("data-state") !== "out"
  );
}

/** Scatter a level away, then stop rendering it. */
function hideLevel(sel) {
  const el = document.querySelector(sel);
  if (!el || !el.getAttribute("data-state")) return;
  el.removeAttribute("data-state");
  void el.offsetWidth;
  el.setAttribute("data-state", "closing");
  randyLevelHideTimer = setTimeout(() => {
    randyLevelHideTimer = null;
    if (el.getAttribute("data-state") === "closing") {
      el.removeAttribute("data-state");
    }
  }, RANDY_MENU_ANIM_MS);
}

/** Scatter a level in. */
function showLevel(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  // Clear first and reflow, or the browser retargets the finished animation
  // instead of replaying it and the level snaps in.
  el.removeAttribute("data-state");
  void el.offsetWidth;
  el.setAttribute("data-state", "open");
}

/**
 * Open the menu to a given depth. Everything else — which level renders,
 * the arrow's flip, and the hover bridge's reach — follows from this.
 * @param {number} depth 0 closed, 1 actions, 2 Tailor children
 */
function setMenuDepth(depth) {
  const next = Math.max(0, Math.min(2, depth));
  const arrow = document.querySelector("#randy-menu-arrow");
  const randy = document.querySelector("#randy");

  if (randyLevelHideTimer) {
    clearTimeout(randyLevelHideTimer);
    randyLevelHideTimer = null;
  }

  // The arrow is the origin the levels come out of, so it has to be there.
  if (next > 0 && !isArrowVisible()) setArrowVisible(true);

  Object.entries(RANDY_MENU_LEVELS).forEach(([lvl, sel]) => {
    if (Number(lvl) === next) showLevel(sel);
    else hideLevel(sel);
  });

  randyMenuDepth = next;
  if (randy) randy.dataset.depth = String(next);
  if (arrow) {
    if (next > 0) arrow.setAttribute("data-expanded", "true");
    else arrow.removeAttribute("data-expanded");
  }

  const tailorBtn = document.querySelector(
    '.randy-menu-item[data-action="cover-letter"]'
  );
  if (tailorBtn) tailorBtn.setAttribute("aria-expanded", String(next === 2));
}

/** How deep the menu is currently open. */
function getMenuDepth() {
  return randyMenuDepth;
}

/**
 * Whether any level is open. content.js uses this for the click toggle and
 * the idle-retreat busy check.
 * @returns {boolean}
 */
function isMenuVisible() {
  return randyMenuDepth > 0;
}

/**
 * Kept for callers that just want the menu shut (or opened to the top
 * level) without knowing about depth.
 * @param {boolean} visible
 */
function setMenuVisible(visible) {
  setMenuDepth(visible ? 1 : 0);
}

/**
 * Build the hover menu once and attach it inside #randy. Guarded against
 * double-creation on SPA re-injection (same pattern as createChoiceButtons).
 * @param {(actionId: string) => void} onSelect - called with the action id;
 *   currently just console.logs (see content.js)
 * @returns {HTMLElement|null} menu element or null when #randy is missing
 */
function createMenu(onSelect) {
  const randy = document.querySelector("#randy");
  if (!randy || document.querySelector("#randy-menu")) {
    return document.querySelector("#randy-menu");
  }
  // The arrow: revealed on hover, clicked to fan the items out. Built here
  // so it shares createMenu's double-injection guard.
  const arrow = document.createElement("div");
  arrow.id = "randy-menu-arrow";
  arrow.style.display = "none";
  arrow.setAttribute("role", "button");
  arrow.setAttribute("tabindex", "0");
  arrow.setAttribute("aria-label", "Randy actions");
  // The arrow walks back up: submenu -> actions -> closed. Closed, it opens
  // to the top level.
  const toggle = (event) => {
    event.stopPropagation();
    setMenuDepth(getMenuDepth() === 0 ? 1 : getMenuDepth() - 1);
  };
  arrow.addEventListener("click", toggle);
  arrow.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") toggle(event);
  });
  randy.appendChild(arrow);

  const menu = document.createElement("div");
  menu.id = "randy-menu";
  // No inline display here: menu.css shows a level only while it carries a
  // data-state, and an inline style would outrank that permanently.

  for (const action of RANDY_MENU_ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "randy-menu-item";
    btn.dataset.action = action.id;
    btn.textContent = action.label;
    // Tailor is now strictly a parent toggle — its children handle the real
    // routing (Cover Letter vs Resume). Keep data-action for styling but
    // intercept click to toggle submenu instead of routing.
    if (action.id === "cover-letter") {
      btn.setAttribute("aria-haspopup", "true");
      btn.setAttribute("aria-expanded", "false");
      // Drill in: the three actions scatter away as the two children arrive.
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        setMenuDepth(2);
      });
    } else {
      // The menu stays open on selection: the reply lands in the bubble
      // beside it, and a second action is one click away. It closes on the
      // arrow or when the hover grace runs out.
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (typeof onSelect === "function") {
          onSelect(action.id);
        }
      });
    }
    menu.appendChild(btn);
  }

  // Tailor submenu: fanned LEFT of the Tailor button (middle arc item)
  const tailorSub = document.createElement("div");
  tailorSub.id = "randy-tailor-submenu";
  // No hover-gap handlers here: #randy::before bridges every gap between
  // the otter, the arrow and both levels, so mouseleave only fires when the
  // cursor genuinely leaves the whole rig.

  for (const sub of RANDY_TAILOR_ACTIONS) {
    const sbtn = document.createElement("button");
    sbtn.type = "button";
    sbtn.className = "randy-tailor-item";
    sbtn.dataset.action = sub.id;
    sbtn.dataset.tailor = "true";
    sbtn.textContent = sub.label;
    sbtn.addEventListener("click", (event) => {
      event.stopPropagation();
      // Same here — picking Cover Letter or Resume leaves the menu up.
      if (typeof onSelect === "function") {
        // Route as distinct ids: "cover-letter" (existing) and "resume" (new)
        onSelect(sub.id);
      }
    });
    tailorSub.appendChild(sbtn);
  }

  randy.appendChild(menu);
  randy.appendChild(tailorSub);
  return menu;
}

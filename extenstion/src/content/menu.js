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
const RANDY_MENU_ACTIONS = [
  { id: "match-score", label: "Match" },
  { id: "track", label: "Track" },
  { id: "cover-letter", label: "Tailor" },
];

// Fan-out duration (200ms) plus the last item's 100ms delay. Must match the
// animations in menu.css — items can only be hidden once the collapse has
// finished playing. The arrow's dissolve is shorter and finishes inside it.
const RANDY_MENU_ANIM_MS = 300;
const RANDY_ARROW_ANIM_MS = 200;
let randyMenuCloseTimer = null;
let randyArrowHideTimer = null;

/**
 * Show or hide the arrow. Revealing it is the only thing hover does now —
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
    // finished one (same reason as the menu below).
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

/**
 * Fan the items out of the arrow, or retract them. Also flips the arrow so
 * it reads as a collapse control while open.
 * @param {boolean} visible
 */
function setMenuVisible(visible) {
  const menu = document.querySelector("#randy-menu");
  const arrow = document.querySelector("#randy-menu-arrow");
  if (!menu) return;

  if (randyMenuCloseTimer) {
    clearTimeout(randyMenuCloseTimer);
    randyMenuCloseTimer = null;
  }

  if (visible) {
    // The arrow is the origin the items fan out of, so it has to be there.
    if (!isArrowVisible()) setArrowVisible(true);
    if (arrow) arrow.setAttribute("data-expanded", "true");
    menu.removeAttribute("data-state");
    menu.style.display = "block";
    // Restart the fan: both states drive the same animation-name, so without
    // clearing and reflowing first the browser retargets the finished
    // animation and the items jump straight to their end state.
    void menu.offsetWidth;
    menu.setAttribute("data-state", "open");
    return;
  }

  if (arrow) arrow.removeAttribute("data-expanded");
  if (menu.style.display !== "block") return;

  menu.removeAttribute("data-state");
  void menu.offsetWidth;
  menu.setAttribute("data-state", "closing");
  randyMenuCloseTimer = setTimeout(() => {
    randyMenuCloseTimer = null;
    menu.style.display = "none";
    menu.removeAttribute("data-state");
  }, RANDY_MENU_ANIM_MS);
}

/**
 * Whether the items are fanned out. Mid-collapse counts as closed, so
 * clicking during the retract re-opens rather than toggling back off.
 * @returns {boolean}
 */
function isMenuVisible() {
  const menu = document.querySelector("#randy-menu");
  return Boolean(
    menu &&
      menu.style.display === "block" &&
      menu.getAttribute("data-state") !== "closing"
  );
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
  const toggle = (event) => {
    event.stopPropagation();
    setMenuVisible(!isMenuVisible());
  };
  arrow.addEventListener("click", toggle);
  arrow.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") toggle(event);
  });
  randy.appendChild(arrow);

  const menu = document.createElement("div");
  menu.id = "randy-menu";
  // Hidden until the arrow is clicked — hover only reveals the arrow.
  menu.style.display = "none";

  for (const action of RANDY_MENU_ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "randy-menu-item";
    btn.dataset.action = action.id;
    btn.textContent = action.label;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof onSelect === "function") {
        onSelect(action.id);
      }
    });
    menu.appendChild(btn);
  }

  randy.appendChild(menu);
  return menu;
}

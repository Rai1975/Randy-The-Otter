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

// Action registry: id is the stable hook for future wiring, label is shown.
const RANDY_MENU_ACTIONS = [
  { id: "roast", label: "Roast" },
  { id: "cover-letter", label: "Custom cover letter" },
  { id: "match-score", label: "Job match score" },
];

// Length of the pixel-dissolve in menu.css. Must match it — the element can
// only be hidden once the closing dissolve has finished playing.
const RANDY_MENU_ANIM_MS = 260;
let randyMenuCloseTimer = null;

/**
 * Show or hide the hover menu. Hidden by default — content.js opens it on
 * hover and closes it after a grace period on mouseleave (re-entering
 * cancels the close), or instantly on poke.
 *
 * Closing is deferred: display:none can't animate, so the menu is tagged
 * data-state="closing" to play the cascade in reverse and only actually
 * hidden once that finishes.
 * @param {boolean} visible - true to open the menu, false to close it
 */
function setMenuVisible(visible) {
  const menu = document.querySelector("#randy-menu");
  if (!menu) return;

  if (randyMenuCloseTimer) {
    clearTimeout(randyMenuCloseTimer);
    randyMenuCloseTimer = null;
  }

  if (visible) {
    menu.removeAttribute("data-state");
    menu.style.display = "flex";
    // Restart the animation on a re-open: without a reflow between clearing
    // and re-setting the state, the browser coalesces both into no change
    // and the cascade doesn't replay.
    void menu.offsetWidth;
    menu.setAttribute("data-state", "open");
    return;
  }

  if (menu.style.display === "none") return;

  // Same restart dance as opening, and for a subtler reason: both states
  // drive the SAME animation-name, so swapping the attribute alone just
  // retargets the already-finished open animation. Flipping direction on a
  // finished animation snaps straight to its reversed end state — the menu
  // would vanish instantly instead of dissolving. Clearing the attribute
  // drops the animation entirely, and the reflow commits that before the
  // closing one starts fresh.
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
 * Whether the hover menu is currently open. A menu mid-close counts as
 * closed, so clicking during the fade-out re-opens it rather than
 * toggling it back off.
 * @returns {boolean} true when the menu is open
 */
function isMenuVisible() {
  const menu = document.querySelector("#randy-menu");
  return Boolean(
    menu &&
      menu.style.display !== "none" &&
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
  const menu = document.createElement("div");
  menu.id = "randy-menu";
  // Hidden until a >1s hover opens it.
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

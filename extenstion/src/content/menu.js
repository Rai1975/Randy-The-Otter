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

/**
 * Show or hide the hover menu. Hidden by default — content.js shows it
 * after a >1s hover and hides it after a short grace period on
 * mouseleave (re-entering cancels the close), or instantly on poke.
 * @param {boolean} visible - true to open the menu, false to close it
 */
function setMenuVisible(visible) {
  const menu = document.querySelector("#randy-menu");
  if (menu) {
    menu.style.display = visible ? "" : "none";
  }
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

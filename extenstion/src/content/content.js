console.log("Randy loaded!");

// Sprite map — default is "idle". Future states just add entries here
// (e.g. happy, sad) and call setRandySprite(name).
const RANDY_SPRITES = {
  idle: chrome.runtime.getURL("src/assets/idle-alert.gif"),
  talking: chrome.runtime.getURL("src/assets/talk.gif"),
};

let currentSprite = "idle";

// Preload all sprites so future idle <-> talking swaps don't flicker.
Object.values(RANDY_SPRITES).forEach((url) => {
  const preload = new Image();
  preload.src = url;
});

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
  const { wrap: bubbleWrap } = createBubble("HEY!");

  const character = document.createElement("img");
  character.id = "randy-character";
  character.src = RANDY_SPRITES[currentSprite];
  character.alt = "Randy the Otter";
  character.draggable = false;

  // If the gif fails to load (missing resource, CSP), keep the bubble usable.
  character.addEventListener("error", () => {
    console.warn("[Randy] Failed to load sprite:", character.src);
    character.style.display = "none";
  });

  bubbleWrap.addEventListener("click", () => {
    setBubbleText("STOP CLICKING ME BRO");
  });

  randy.appendChild(bubbleWrap);
  randy.appendChild(character);
  document.body.appendChild(randy);

  return randy;
}

createRandy();

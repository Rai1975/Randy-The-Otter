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
 *
 * The tail must NOT live inside the frame: clip-path on the frame
 * clips all of its descendants, so an overhanging tail child gets
 * sliced off. As a sibling inside the unclipped wrap it renders fully.
 */

function createBubble(initialText) {
  const wrap = document.createElement("div");
  wrap.id = "randy-bubble-wrap";

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
  wrap.appendChild(frame);
  wrap.appendChild(tail);

  return { wrap, frame, bubble };
}

/**
 * Update the speech bubble text. Bubble width stays capped at
 * Randy's own width via CSS (max-width: var(--randy-size)) and
 * grows vertically instead.
 * @param {string} text - text to show in the bubble
 */
function setBubbleText(text) {
  const bubble = document.querySelector("#randy-bubble");
  if (bubble) {
    bubble.textContent = text;
  }
}

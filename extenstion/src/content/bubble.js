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
 * @param {string} text - text to show in the bubble (must come from backend `reply`)
 */
function setBubbleText(text) {
  const bubble = document.querySelector("#randy-bubble");
  if (bubble) {
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
 * Render a backend response: bubble text from `reply` plus Yes/No
 * visibility from `is_question` (strict true shows, anything else hides).
 *
 * Stale guard: responses carry the send-order tag `__randySeq`
 * (see postRandyEnvelope). A response older than the newest one already
 * rendered is dropped, so a slow earlier request can never overwrite a
 * newer message. Null (failed request) carries no new information and is
 * a no-op — it must not clobber fresh UI either.
 * @param {object|null} data - backend JSON with `reply` / `is_question`
 * @returns {boolean} true when a reply was rendered
 */
function setBubbleFromBackend(data) {
  if (!data || typeof data !== "object") {
    return false;
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
  setChoicesVisible(data.is_question === true);
  const reply =
    typeof getRandyReply === "function" ? getRandyReply(data) : null;
  if (reply) {
    setBubbleText(reply);
    return true;
  }
  return false;
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

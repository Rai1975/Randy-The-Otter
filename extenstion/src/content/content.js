console.log("Randy loaded!");

const randy = document.createElement("div");

randy.id = "randy";

randy.innerHTML = `
    <div id="randy-bubble">
        Hey! 👋
    </div>
`;

document.body.appendChild(randy);

const bubble = document.querySelector("#randy-bubble");

bubble.addEventListener("click", () => {
    bubble.textContent = "STOP CLICKING ME BRO";
});
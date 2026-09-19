const RANDY_PREFERENCES_KEY = "randyPreferences";
const RANDY_PREFERENCES_VERSION = 1;

const DEFAULT_PREFERENCES = {
	version: RANDY_PREFERENCES_VERSION,
	sponsorship: "any",
	pay: { currency: "USD", min: null, max: null },
	locations: { presets: [], custom: [], remote: false },
	titles: [],
	opportunityTypes: [],
};

function cleanList(values) {
	return [...new Set((Array.isArray(values) ? values : [])
		.filter((value) => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean))];
}

function numberOrNull(value) {
	if (value === "" || value === null || value === undefined) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePreferences(value) {
	const source = value && typeof value === "object" ? value : {};
	const pay = source.pay && typeof source.pay === "object" ? source.pay : {};
	const locations = source.locations && typeof source.locations === "object" ? source.locations : {};
	const sponsorship = ["any", "preferred", "required"].includes(source.sponsorship)
		? source.sponsorship : DEFAULT_PREFERENCES.sponsorship;
	return {
		version: RANDY_PREFERENCES_VERSION,
		sponsorship,
		pay: {
			currency: ["USD", "CAD", "EUR", "GBP"].includes(pay.currency) ? pay.currency : "USD",
			min: numberOrNull(pay.min),
			max: numberOrNull(pay.max),
		},
		locations: {
			presets: cleanList(locations.presets),
			custom: cleanList(locations.custom),
			remote: locations.remote === true,
		},
		titles: cleanList(source.titles),
		opportunityTypes: cleanList(source.opportunityTypes).filter((type) => ["internship", "full_time"].includes(type)),
	};
}

function getRows(listId) {
	return [...document.querySelectorAll(`#${listId} input`)].map((input) => input.value);
}

function addRow(listId, value = "") {
	const list = document.getElementById(listId);
	const row = document.createElement("div");
	row.className = "repeat-row";
	row.innerHTML = `<input type="text" value=""><button type="button" aria-label="Remove entry">x</button>`;
	row.querySelector("input").value = value;
	row.querySelector("button").addEventListener("click", () => row.remove());
	list.appendChild(row);
}

function renderPreferences(preferences) {
	const value = normalizePreferences(preferences);
	document.getElementById("sponsorship").value = value.sponsorship;
	document.getElementById("pay-currency").value = value.pay.currency;
	document.getElementById("pay-min").value = value.pay.min ?? "";
	document.getElementById("pay-max").value = value.pay.max ?? "";
	document.querySelectorAll("input[name='opportunityType']").forEach((input) => {
		input.checked = value.opportunityTypes.includes(input.value);
	});
	document.querySelectorAll("input[name='locationPreset']").forEach((input) => {
		input.checked = value.locations.presets.includes(input.value);
	});
	document.querySelector("input[name='remote']").checked = value.locations.remote;
	document.getElementById("titles-list").replaceChildren();
	document.getElementById("locations-list").replaceChildren();
	value.titles.forEach((title) => addRow("titles-list", title));
	value.locations.custom.forEach((location) => addRow("locations-list", location));
}

function readPreferences() {
	return normalizePreferences({
		sponsorship: document.getElementById("sponsorship").value,
		pay: {
			currency: document.getElementById("pay-currency").value,
			min: document.getElementById("pay-min").value,
			max: document.getElementById("pay-max").value,
		},
		locations: {
			presets: [...document.querySelectorAll("input[name='locationPreset']:checked")].map((input) => input.value),
			custom: getRows("locations-list"),
			remote: document.querySelector("input[name='remote']").checked,
		},
		titles: getRows("titles-list"),
		opportunityTypes: [...document.querySelectorAll("input[name='opportunityType']:checked")].map((input) => input.value),
	});
}

function setStatus(message, isError = false) {
	const status = document.getElementById("form-status");
	status.textContent = message;
	status.style.color = isError ? "#b74421" : "#28734d";
}

document.querySelectorAll("[data-add-row]").forEach((button) => {
	button.addEventListener("click", () => addRow(button.dataset.addRow));
});

document.getElementById("preferences-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const preferences = readPreferences();
	if (preferences.pay.min !== null && preferences.pay.max !== null && preferences.pay.min > preferences.pay.max) {
		setStatus("Minimum pay cannot be greater than maximum pay.", true);
		return;
	}
	await chrome.storage.local.set({ [RANDY_PREFERENCES_KEY]: preferences });
	setStatus("Preferences saved.");
});

document.getElementById("reset-button").addEventListener("click", async () => {
	renderPreferences(DEFAULT_PREFERENCES);
	await chrome.storage.local.set({ [RANDY_PREFERENCES_KEY]: DEFAULT_PREFERENCES });
	setStatus("Preferences reset.");
});

chrome.storage.local.get(RANDY_PREFERENCES_KEY).then((result) => {
	renderPreferences(result[RANDY_PREFERENCES_KEY] || DEFAULT_PREFERENCES);
}).catch(() => {
	renderPreferences(DEFAULT_PREFERENCES);
	setStatus("Could not load saved preferences.", true);
});

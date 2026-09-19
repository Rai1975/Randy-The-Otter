const RANDY_PREFERENCES_KEY = "randyPreferences";
const RANDY_PREFERENCES_VERSION = 1;

const DEFAULT_PREFERENCES = {
	version: RANDY_PREFERENCES_VERSION,
	sponsorship: "any",
	pay: { currency: "USD", min: null, max: null },
	locations: { presets: [], custom: [], customSelected: [], remote: false },
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
	const customLocations = cleanList(locations.custom);
	const customSelected = Array.isArray(locations.customSelected)
		? cleanList(locations.customSelected).filter((location) => customLocations.includes(location))
		: customLocations;
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
			custom: customLocations,
			customSelected,
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
	row.querySelector("button").addEventListener("click", () => {
		row.remove();
		savePreferences();
	});
	list.appendChild(row);
}

function renderCustomLocations(customLocations, selectedLocations) {
	const list = document.getElementById("custom-locations-list");
	list.replaceChildren();
	customLocations.forEach((location) => {
		const choice = document.createElement("label");
		choice.className = "choice custom-choice";
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.name = "customLocation";
		checkbox.value = location;
		checkbox.checked = selectedLocations.includes(location);
		const text = document.createElement("span");
		text.textContent = location;
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "remove-location-button";
		remove.setAttribute("aria-label", `Remove ${location}`);
		remove.textContent = "X";
		remove.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			choice.remove();
			savePreferences();
		});
		choice.append(checkbox, text, remove);
		list.appendChild(choice);
	});
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
	renderCustomLocations(value.locations.custom, value.locations.customSelected);
	document.getElementById("titles-list").replaceChildren();
	value.titles.forEach((title) => addRow("titles-list", title));
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
			custom: [...document.querySelectorAll("input[name='customLocation']")].map((input) => input.value),
			customSelected: [...document.querySelectorAll("input[name='customLocation']:checked")].map((input) => input.value),
			remote: document.querySelector("input[name='remote']").checked,
		},
		titles: getRows("titles-list"),
		opportunityTypes: [...document.querySelectorAll("input[name='opportunityType']:checked")].map((input) => input.value),
	});
}

function setStatus(message, isError = false) {
	const status = document.getElementById("form-status");
	status.textContent = message;
	status.style.color = isError ? "var(--accent-dark)" : "var(--accent)";
}

let autosaveTimer = null;

async function savePreferences(showStatus = false) {
	const preferences = readPreferences();
	if (preferences.pay.min !== null && preferences.pay.max !== null && preferences.pay.min > preferences.pay.max) {
		if (showStatus) setStatus("Minimum pay cannot be greater than maximum pay.", true);
		return false;
	}
	try {
		await chrome.storage.local.set({ [RANDY_PREFERENCES_KEY]: preferences });
		if (showStatus) setStatus("Preferences saved.");
		return true;
	} catch (error) {
		setStatus("Could not save preferences.", true);
		return false;
	}
}

function scheduleAutosave() {
	if (autosaveTimer) clearTimeout(autosaveTimer);
	autosaveTimer = setTimeout(() => {
		autosaveTimer = null;
		savePreferences();
	}, 250);
}

document.querySelectorAll("[data-add-row]").forEach((button) => {
	button.addEventListener("click", () => addRow(button.dataset.addRow));
});

document.getElementById("add-location-button").addEventListener("click", () => {
	const input = document.getElementById("custom-location-input");
	const location = input.value.trim();
	if (!location) return;
	const existing = [...document.querySelectorAll("input[name='customLocation']")].map((item) => item.value.toLowerCase());
	if (existing.includes(location.toLowerCase())) {
		setStatus("That location is already added.", true);
		return;
	}
	const current = [...document.querySelectorAll("input[name='customLocation']")].map((item) => item.value);
	const selected = [...document.querySelectorAll("input[name='customLocation']:checked")].map((item) => item.value);
	current.push(location);
	selected.push(location);
	renderCustomLocations(current, selected);
	input.value = "";
	input.focus();
	savePreferences();
});

document.getElementById("custom-location-input").addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		document.getElementById("add-location-button").click();
	}
});

const preferencesForm = document.getElementById("preferences-form");

preferencesForm.addEventListener("change", () => {
	savePreferences();
});

preferencesForm.addEventListener("input", () => {
	scheduleAutosave();
});

preferencesForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	await savePreferences(true);
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

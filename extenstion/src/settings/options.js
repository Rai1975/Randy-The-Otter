const RANDY_PREFERENCES_KEY = "randyPreferences";
const RANDY_PREFERENCES_VERSION = 1;

const DEFAULT_PREFERENCES = {
	version: RANDY_PREFERENCES_VERSION,
	sponsorship: "any",
	pay: { currency: "USD", min: null, max: null },
	locations: { presets: [], custom: [], customSelected: [], remote: false },
	titles: [],
	opportunityTypes: [],
	personalInformation: {
		firstName: "",
		lastName: "",
		phoneNumber: "",
		email: "",
		homeAddress: "",
		linkedinUrl: "",
		websiteUrl: "",
		veteranStatus: "",
		disabilityStatus: "",
		race: "",
		gender: "",
	},
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

function cleanText(value, maxLength = 300) {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizePreferences(value) {
	const source = value && typeof value === "object" ? value : {};
	const pay = source.pay && typeof source.pay === "object" ? source.pay : {};
	const locations = source.locations && typeof source.locations === "object" ? source.locations : {};
	const personalInformation = source.personalInformation && typeof source.personalInformation === "object"
		? source.personalInformation : {};
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
		personalInformation: {
			firstName: cleanText(personalInformation.firstName),
			lastName: cleanText(personalInformation.lastName),
			phoneNumber: cleanText(personalInformation.phoneNumber),
			email: cleanText(personalInformation.email),
			homeAddress: cleanText(personalInformation.homeAddress),
			linkedinUrl: cleanText(personalInformation.linkedinUrl, 500),
			websiteUrl: cleanText(personalInformation.websiteUrl, 500),
			veteranStatus: ["", "I am a protected veteran", "I am not a protected veteran", "I do not wish to answer"].includes(personalInformation.veteranStatus) ? personalInformation.veteranStatus : "",
			disabilityStatus: ["", "Yes, I have a disability", "No, I do not have a disability", "I do not wish to answer"].includes(personalInformation.disabilityStatus) ? personalInformation.disabilityStatus : "",
			race: ["", "Hispanic or Latino", "Not Hispanic or Latino", "American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or more races", "I do not wish to answer"].includes(personalInformation.race) ? personalInformation.race : "",
			gender: ["", "Man", "Woman", "Non-binary", "Another gender identity", "I do not wish to answer"].includes(personalInformation.gender) ? personalInformation.gender : "",
		},
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
	const personalInformation = value.personalInformation;
	document.getElementById("personal-first-name").value = personalInformation.firstName;
	document.getElementById("personal-last-name").value = personalInformation.lastName;
	document.getElementById("personal-phone").value = personalInformation.phoneNumber;
	document.getElementById("personal-email").value = personalInformation.email;
	document.getElementById("personal-home-address").value = personalInformation.homeAddress;
	document.getElementById("personal-linkedin-url").value = personalInformation.linkedinUrl;
	document.getElementById("personal-website-url").value = personalInformation.websiteUrl;
	document.getElementById("personal-veteran-status").value = personalInformation.veteranStatus;
	document.getElementById("personal-disability-status").value = personalInformation.disabilityStatus;
	document.getElementById("personal-race").value = personalInformation.race;
	document.getElementById("personal-gender").value = personalInformation.gender;
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
		personalInformation: {
			firstName: document.getElementById("personal-first-name").value,
			lastName: document.getElementById("personal-last-name").value,
			phoneNumber: document.getElementById("personal-phone").value,
			email: document.getElementById("personal-email").value,
			homeAddress: document.getElementById("personal-home-address").value,
			linkedinUrl: document.getElementById("personal-linkedin-url").value,
			websiteUrl: document.getElementById("personal-website-url").value,
			veteranStatus: document.getElementById("personal-veteran-status").value,
			disabilityStatus: document.getElementById("personal-disability-status").value,
			race: document.getElementById("personal-race").value,
			gender: document.getElementById("personal-gender").value,
		},
	});
}

function setStatus(message, isError = false) {
	const status = document.getElementById("form-status");
	status.textContent = message;
	status.style.color = isError ? "var(--accent-dark)" : "var(--accent)";
}

let autosaveTimer = null;
let addressSearchTimer = null;
let addressSearchController = null;
let addressSuggestions = [];
let addressSuggestionIndex = -1;

function closeAddressSuggestions() {
	const list = document.getElementById("address-suggestions");
	list.replaceChildren();
	list.hidden = true;
	addressSuggestions = [];
	addressSuggestionIndex = -1;
}

function selectAddressSuggestion(index) {
	const suggestion = addressSuggestions[index];
	if (!suggestion) return;
	const input = document.getElementById("personal-home-address");
	input.value = suggestion.display_name;
	closeAddressSuggestions();
	input.focus();
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderAddressSuggestions(results) {
	const list = document.getElementById("address-suggestions");
	list.replaceChildren();
	addressSuggestions = results;
	addressSuggestionIndex = -1;
	if (!results.length) {
		list.hidden = true;
		return;
	}
	results.forEach((suggestion, index) => {
		const option = document.createElement("button");
		option.type = "button";
		option.className = "address-suggestion";
		option.setAttribute("role", "option");
		option.setAttribute("aria-selected", "false");
		option.textContent = suggestion.display_name;
		option.addEventListener("mousedown", (event) => event.preventDefault());
		option.addEventListener("click", () => selectAddressSuggestion(index));
		list.appendChild(option);
	});
	list.hidden = false;
}

async function searchAddresses(query) {
	if (addressSearchController) addressSearchController.abort();
	addressSearchController = new AbortController();
	try {
		const url = new URL("https://nominatim.openstreetmap.org/search");
		url.searchParams.set("q", query);
		url.searchParams.set("format", "jsonv2");
		url.searchParams.set("limit", "5");
		url.searchParams.set("addressdetails", "1");
		const response = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: addressSearchController.signal,
		});
		if (!response.ok) throw new Error(`Address search responded ${response.status}`);
		renderAddressSuggestions(await response.json());
	} catch (error) {
		if (error.name !== "AbortError") closeAddressSuggestions();
	}
}

function updateAddressSuggestionHighlight() {
	[...document.querySelectorAll(".address-suggestion")].forEach((option, index) => {
		option.setAttribute("aria-selected", String(index === addressSuggestionIndex));
	});
}

function setupAddressAutocomplete() {
	const input = document.getElementById("personal-home-address");
	input.addEventListener("input", () => {
		clearTimeout(addressSearchTimer);
		const query = input.value.trim();
		if (query.length < 3) {
			closeAddressSuggestions();
			return;
		}
		addressSearchTimer = setTimeout(() => searchAddresses(query), 350);
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" && addressSuggestions.length) {
			event.preventDefault();
			addressSuggestionIndex = (addressSuggestionIndex + 1) % addressSuggestions.length;
			updateAddressSuggestionHighlight();
		} else if (event.key === "ArrowUp" && addressSuggestions.length) {
			event.preventDefault();
			addressSuggestionIndex = (addressSuggestionIndex - 1 + addressSuggestions.length) % addressSuggestions.length;
			updateAddressSuggestionHighlight();
		} else if (event.key === "Enter" && addressSuggestionIndex >= 0) {
			event.preventDefault();
			selectAddressSuggestion(addressSuggestionIndex);
		} else if (event.key === "Escape") {
			closeAddressSuggestions();
		}
	});
	input.addEventListener("blur", () => setTimeout(closeAddressSuggestions, 150));
}

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

setupAddressAutocomplete();

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

// ---- Portfolio (experiences / projects / coursework) ----
const PORTFOLIO_API_BASE = "http://127.0.0.1:5000/portfolio";
const PORTFOLIO_TABS = ["experiences", "projects", "coursework"];
let portfolioState = { experiences: [], projects: [], coursework: [] };
let portfolioTimers = {};
let portfolioActiveTab = "experiences";

function setPortfolioStatus(message, isError = false) {
	const el = document.getElementById("portfolio-status");
	if (!el) return;
	el.textContent = message || "";
	el.style.color = isError ? "var(--accent-dark)" : "var(--muted)";
	if (message) setTimeout(() => { if (el.textContent === message) el.textContent = ""; }, 3500);
}

function portfolioFieldDefs(tab) {
	if (tab === "experiences") {
		return [
			{ key: "title", label: "Title *", type: "text", placeholder: "e.g. Product Engineer Intern" },
			{ key: "organization", label: "Organization", type: "text", placeholder: "e.g. Benchmark Gensuite" },
			{ key: "date", label: "Date", type: "text", placeholder: "e.g. Mar 2026 - Aug 2026" },
			{ key: "link", label: "Link", type: "text", placeholder: "https://..." },
			{ key: "description", label: "Description", type: "textarea", placeholder: "Bullet points or summary..." },
		];
	}
	// projects & coursework share shape (no pictures per spec)
	return [
		{ key: "title", label: "Title *", type: "text", placeholder: "e.g. Whitebox" },
		{ key: "link", label: "Link", type: "text", placeholder: "https://..." },
		{ key: "stack", label: "Stack", type: "text", placeholder: "e.g. python, flask, react" },
		{ key: "category", label: "Category", type: "text", placeholder: "e.g. AI/ML" },
		{ key: "description", label: "Description", type: "textarea", placeholder: "What you built..." },
	];
}

function normalizePortfolioItem(tab, item) {
	const defs = portfolioFieldDefs(tab);
	const out = {};
	defs.forEach((d) => {
		const v = item[d.key];
		out[d.key] = typeof v === "string" ? v.trim().slice(0, d.key === "description" ? 5000 : 500) : "";
	});
	// title required
	if (!out.title) return null;
	return out;
}

function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function renderPortfolioTab(tab) {
	const panel = document.getElementById(`tab-${tab}`);
	if (!panel) return;
	panel.replaceChildren();
	const items = portfolioState[tab] || [];
	if (!items.length) {
		const empty = document.createElement("div");
		empty.className = "portfolio-empty";
		empty.textContent = `No ${tab} yet. Add one below.`;
		panel.appendChild(empty);
		return;
	}
	items.forEach((item, idx) => {
		const card = document.createElement("div");
		card.className = "portfolio-card";
		card.dataset.index = String(idx);
		card.dataset.tab = tab;
		const header = document.createElement("div");
		header.className = "portfolio-card-header";
		header.innerHTML = `<span class="portfolio-card-index">#${idx + 1}</span><button class="portfolio-card-remove" type="button" aria-label="Remove ${escapeHtml(tab)} ${idx+1}">Remove</button>`;
		header.querySelector("button").addEventListener("click", () => {
			portfolioState[tab].splice(idx, 1);
			renderPortfolioTab(tab);
			schedulePortfolioSave(tab);
		});
		card.appendChild(header);
		portfolioFieldDefs(tab).forEach((def) => {
			const label = document.createElement("label");
			label.textContent = def.label;
			let input;
			if (def.type === "textarea") {
				input = document.createElement("textarea");
				input.value = item[def.key] || "";
				input.placeholder = def.placeholder;
				input.rows = 4;
			} else {
				input = document.createElement("input");
				input.type = "text";
				input.value = item[def.key] || "";
				input.placeholder = def.placeholder;
			}
			input.dataset.key = def.key;
			input.addEventListener("input", () => {
				portfolioState[tab][idx][def.key] = input.value;
				schedulePortfolioSave(tab);
			});
			label.appendChild(input);
			card.appendChild(label);
		});
		panel.appendChild(card);
	});
}

function renderAllPortfolioTabs() {
	PORTFOLIO_TABS.forEach((t) => renderPortfolioTab(t));
}

function switchPortfolioTab(tab) {
	if (!PORTFOLIO_TABS.includes(tab)) return;
	portfolioActiveTab = tab;
	document.querySelectorAll(".tab-button").forEach((btn) => {
		const isActive = btn.dataset.tab === tab;
		btn.classList.toggle("is-active", isActive);
		btn.setAttribute("aria-selected", String(isActive));
	});
	PORTFOLIO_TABS.forEach((t) => {
		const panel = document.getElementById(`tab-${t}`);
		if (panel) panel.hidden = t !== tab;
	});
	// show only relevant add button
	document.querySelectorAll("[data-portfolio-add]").forEach((btn) => {
		btn.hidden = btn.dataset.portfolioAdd !== tab;
	});
}

async function fetchPortfolioFromBackend() {
	const result = { experiences: null, projects: null, coursework: null };
	try {
		const res = await fetch(`${PORTFOLIO_API_BASE}`, { headers: { Accept: "application/json" } });
		if (res.ok) {
			const data = await res.json();
			if (Array.isArray(data.experiences)) result.experiences = data.experiences;
			if (Array.isArray(data.projects)) result.projects = data.projects;
			if (Array.isArray(data.coursework)) result.coursework = data.coursework;
			if (result.experiences !== null) return result;
		}
	} catch (_) {}
	// fallback per-tab fetch
	for (const tab of PORTFOLIO_TABS) {
		if (result[tab] !== null) continue;
		try {
			const r = await fetch(`${PORTFOLIO_API_BASE}/${tab}`, { headers: { Accept: "application/json" } });
			if (r.ok) {
				const d = await r.json();
				if (Array.isArray(d[tab])) result[tab] = d[tab];
			}
		} catch (_) {}
	}
	return result;
}

async function putPortfolioTab(tab) {
	const items = portfolioState[tab] || [];
	// Block save if any card has empty title (user mid-edit) - keep backend intact
	for (let i = 0; i < items.length; i++) {
		if (!items[i].title || !String(items[i].title).trim()) {
			setPortfolioStatus("Title is required - fill it before saving.", true);
			return false;
		}
	}
	const filtered = [];
	for (const it of items) {
		const n = normalizePortfolioItem(tab, it);
		if (n) filtered.push(n);
		else {
			setPortfolioStatus("Invalid entry - check titles.", true);
			return false;
		}
	}
	try {
		const res = await fetch(`${PORTFOLIO_API_BASE}/${tab}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ [tab]: filtered }),
		});
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			setPortfolioStatus(body?.message || `Could not save ${tab}.`, true);
			return false;
		}
		// sync state to server-normalized (ensures caps applied)
		if (body && Array.isArray(body[tab])) portfolioState[tab] = body[tab];
		setPortfolioStatus(`${tab} saved to backend.`);
		return true;
	} catch (e) {
		setPortfolioStatus(`Backend offline - ${tab} not saved.`, true);
		return false;
	}
}

function schedulePortfolioSave(tab) {
	if (portfolioTimers[tab]) clearTimeout(portfolioTimers[tab]);
	portfolioTimers[tab] = setTimeout(async () => {
		portfolioTimers[tab] = null;
		await putPortfolioTab(tab);
	}, 500);
}

function addPortfolioItem(tab) {
	if (!PORTFOLIO_TABS.includes(tab)) return;
	portfolioState[tab].push({ title: "" });
	// ensure we are on that tab
	switchPortfolioTab(tab);
	renderPortfolioTab(tab);
	// focus new card title input (do not autosave yet - wait for title)
	const panel = document.getElementById(`tab-${tab}`);
	const lastCard = panel?.querySelector(".portfolio-card:last-of-type input[data-key='title']");
	if (lastCard) lastCard.focus();
}

document.querySelectorAll(".tab-button").forEach((btn) => {
	btn.addEventListener("click", () => switchPortfolioTab(btn.dataset.tab));
});
document.querySelectorAll("[data-portfolio-add]").forEach((btn) => {
	btn.addEventListener("click", () => addPortfolioItem(btn.dataset.portfolioAdd));
});

async function initPortfolio() {
	const fetched = await fetchPortfolioFromBackend();
	PORTFOLIO_TABS.forEach((tab) => {
		if (Array.isArray(fetched[tab])) portfolioState[tab] = fetched[tab];
		else portfolioState[tab] = [];
	});
	renderAllPortfolioTabs();
	switchPortfolioTab(portfolioActiveTab);
	if (PORTFOLIO_TABS.every((t) => !fetched[t])) setPortfolioStatus("Backend not reachable - showing empty. Start server.py.", true);
}

initPortfolio();

chrome.storage.local.get(RANDY_PREFERENCES_KEY).then((result) => {
	renderPreferences(result[RANDY_PREFERENCES_KEY] || DEFAULT_PREFERENCES);
}).catch(() => {
	renderPreferences(DEFAULT_PREFERENCES);
	setStatus("Could not load saved preferences.", true);
});

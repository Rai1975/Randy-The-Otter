const APPLIED_JOBS_URL = "http://127.0.0.1:5000/applied-jobs";
const APPLICATION_STATUSES = ["applied", "rejected", "interview", "hired"];

const body = document.getElementById("applications-body");
const status = document.getElementById("tracker-status");
const count = document.getElementById("application-count");

function formatAppliedAt(value) {
	if (!value) return "Unknown";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function createStatusSelect(application) {
	const select = document.createElement("select");
	select.className = "status-select";
	select.setAttribute("aria-label", `Status for ${application.title || application.job_id || "application"}`);
	for (const optionValue of APPLICATION_STATUSES) {
		const option = document.createElement("option");
		option.value = optionValue;
		option.textContent = optionValue;
		select.appendChild(option);
	}
	select.value = APPLICATION_STATUSES.includes(application.status) ? application.status : "applied";
	select.addEventListener("change", () => updateApplicationStatus(application, select));
	return select;
}

async function updateApplicationStatus(application, select) {
	const previousStatus = application.status || "applied";
	const nextStatus = select.value;
	select.disabled = true;
	try {
		const response = await fetch(APPLIED_JOBS_URL, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				source: application.source,
				job_id: application.job_id,
				status: nextStatus,
			}),
		});
		const data = await response.json().catch(() => null);
		if (!response.ok) throw new Error(data?.message || data?.error || `Server ${response.status}`);
		application.status = data?.job?.status || nextStatus;
		status.textContent = `Status updated to ${application.status}.`;
	} catch (error) {
		select.value = previousStatus;
		status.textContent = `Could not update application status: ${error.message || error}`;
	} finally {
		select.disabled = false;
	}
}

function renderApplications(applications) {
	body.replaceChildren();
	count.textContent = String(applications.length);
	if (!applications.length) {
		const row = document.createElement("tr");
		row.className = "empty-row";
		row.innerHTML = "<td colspan=\"6\">No applications recorded yet.</td>";
		body.appendChild(row);
		return;
	}
	applications.forEach((application) => {
		const row = document.createElement("tr");
		for (const value of [
			formatAppliedAt(application.applied_at),
			application.company || "Unknown",
			application.title || "Unknown",
			application.source || "Unknown",
			application.job_id || "Unknown",
		]) {
			const cell = document.createElement("td");
			if (value === (application.company || "Unknown") || value === (application.title || "Unknown")) {
				cell.className = "truncated-cell";
				cell.title = value;
				const text = document.createElement("span");
				text.textContent = value;
				cell.appendChild(text);
			} else {
				cell.textContent = value;
			}
			row.appendChild(cell);
		}
		const statusCell = document.createElement("td");
		statusCell.appendChild(createStatusSelect(application));
		row.appendChild(statusCell);
		body.appendChild(row);
	});
}

async function loadApplications() {
	status.textContent = "Loading application history...";
	try {
		const response = await fetch(APPLIED_JOBS_URL, { headers: { Accept: "application/json" } });
		const data = await response.json().catch(() => null);
		if (!response.ok) throw new Error(data?.error || `Server ${response.status}`);
		const applications = Array.isArray(data?.jobs) ? data.jobs : [];
		renderApplications(applications);
		status.textContent = `Showing ${applications.length} application${applications.length === 1 ? "" : "s"}`;
	} catch (error) {
		body.replaceChildren();
		count.textContent = "0";
		status.textContent = `Could not load application history: ${error.message || error}`;
	}
}

document.getElementById("refresh-button").addEventListener("click", loadApplications);
loadApplications();

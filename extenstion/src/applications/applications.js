const APPLIED_JOBS_URL = "http://127.0.0.1:5000/applied-jobs";

const body = document.getElementById("applications-body");
const status = document.getElementById("tracker-status");
const count = document.getElementById("application-count");

function formatAppliedAt(value) {
	if (!value) return "Unknown";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function renderApplications(applications) {
	body.replaceChildren();
	count.textContent = String(applications.length);
	if (!applications.length) {
		const row = document.createElement("tr");
		row.className = "empty-row";
		row.innerHTML = "<td colspan=\"3\">No applications recorded yet.</td>";
		body.appendChild(row);
		return;
	}
	applications.forEach((application) => {
		const row = document.createElement("tr");
		for (const value of [formatAppliedAt(application.applied_at), application.source || "Unknown", application.job_id || "Unknown"]) {
			const cell = document.createElement("td");
			cell.textContent = value;
			row.appendChild(cell);
		}
		body.appendChild(row);
	});
}

async function loadApplications() {
	status.textContent = "Loading application history...";
	try {
		const response = await fetch(APPLIED_JOBS_URL, { headers: { Accept: "application/json" } });
		const data = await response.json().catch(() => null);
		if (!response.ok) throw new Error(data?.error || `Server ${response.status}`);
		const applications = Array.isArray(data?.applications) ? data.applications : [];
		renderApplications(applications);
		status.textContent = `Showing ${applications.length} record${applications.length === 1 ? "" : "s"} from applied_jobs.csv.`;
	} catch (error) {
		body.replaceChildren();
		count.textContent = "0";
		status.textContent = `Could not load application history: ${error.message || error}`;
	}
}

document.getElementById("refresh-button").addEventListener("click", loadApplications);
loadApplications();

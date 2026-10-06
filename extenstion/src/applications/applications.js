/* Randy application tracker — chrome.storage.local only (no backend).
 * Depends on ../api/randy-tracker.js (getAppliedJobs, updateAppliedJobStatus,
 * deleteAppliedJob, RANDY_APPLICATION_STATUSES).
 */
const APPLICATION_STATUSES = typeof RANDY_APPLICATION_STATUSES !== "undefined"
	? RANDY_APPLICATION_STATUSES
	: ["applied", "rejected", "interview", "hired"];

const body = document.getElementById("applications-body");
const status = document.getElementById("tracker-status");
const count = document.getElementById("application-count");
const filterSelect = document.getElementById("status-filter");

let allApplications = [];

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

function createDeleteButton(application) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "delete-button";
	btn.textContent = "Delete";
	btn.setAttribute("aria-label", `Delete ${application.title || application.job_id || "application"}`);
	btn.addEventListener("click", () => deleteApplication(application, btn));
	return btn;
}

async function updateApplicationStatus(application, select) {
	const previousStatus = application.status || "applied";
	const nextStatus = select.value;
	select.disabled = true;
	try {
		const updated = await updateAppliedJobStatus(application.source, application.job_id, nextStatus);
		if (!updated) throw new Error("Application not found locally");
		application.status = updated.status;
		allApplications = allApplications.map((a) =>
			a.source === application.source && a.job_id === application.job_id ? application : a
		);
		status.textContent = `Status updated to ${application.status}.`;
	} catch (error) {
		select.value = previousStatus;
		status.textContent = `Could not update application status: ${error.message || error}`;
	} finally {
		select.disabled = false;
	}
}

async function deleteApplication(application, btn) {
	btn.disabled = true;
	try {
		const ok = await deleteAppliedJob(application.source, application.job_id);
		if (!ok) throw new Error("Application not found locally");
		allApplications = allApplications.filter(
			(a) => !(a.source === application.source && a.job_id === application.job_id)
		);
		renderApplications(getFilteredApplications());
		status.textContent = "Application deleted.";
	} catch (error) {
		status.textContent = `Could not delete application: ${error.message || error}`;
		btn.disabled = false;
	}
}

function getFilteredApplications() {
	const filter = filterSelect ? filterSelect.value : "all";
	if (!filter || filter === "all") return allApplications;
	return allApplications.filter((a) => (a.status || "applied") === filter);
}

function renderApplications(applications) {
	body.replaceChildren();
	count.textContent = String(applications.length);
	if (!applications.length) {
		const row = document.createElement("tr");
		row.className = "empty-row";
		row.innerHTML = "<td colspan=\"7\">No applications recorded yet.</td>";
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
		const deleteCell = document.createElement("td");
		deleteCell.appendChild(createDeleteButton(application));
		row.appendChild(deleteCell);
		body.appendChild(row);
	});
}

async function loadApplications() {
	status.textContent = "Loading application history...";
	try {
		allApplications = await getAppliedJobs();
		const visible = getFilteredApplications();
		renderApplications(visible);
		status.textContent = `Showing ${visible.length} application${visible.length === 1 ? "" : "s"} (stored locally)`;
	} catch (error) {
		body.replaceChildren();
		count.textContent = "0";
		status.textContent = `Could not load application history: ${error.message || error}`;
	}
}

document.getElementById("refresh-button").addEventListener("click", loadApplications);
if (filterSelect) {
	filterSelect.addEventListener("change", () => {
		const visible = getFilteredApplications();
		renderApplications(visible);
		status.textContent = `Showing ${visible.length} application${visible.length === 1 ? "" : "s"} (stored locally)`;
	});
}
loadApplications();

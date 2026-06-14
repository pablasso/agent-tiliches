const state = {
	token: new URLSearchParams(window.location.search).get("token") || "",
	review: null,
	lineByKey: new Map(),
	comments: new Map(),
	focusLineKey: null,
	submitted: false,
};

const elements = {};

window.addEventListener("DOMContentLoaded", init);
window.addEventListener("beforeunload", (event) => {
	if (!state.submitted && nonEmptyComments().length > 0) {
		event.preventDefault();
		event.returnValue = "";
	}
});

async function init() {
	elements.subtitle = document.querySelector("#subtitle");
	elements.fileList = document.querySelector("#fileList");
	elements.commentList = document.querySelector("#commentList");
	elements.commentCount = document.querySelector("#commentCount");
	elements.diffPane = document.querySelector("#diffPane");
	elements.submitButton = document.querySelector("#submitButton");
	elements.cancelButton = document.querySelector("#cancelButton");
	elements.toast = document.querySelector("#toast");

	elements.submitButton.addEventListener("click", submitReview);
	elements.cancelButton.addEventListener("click", cancelReview);

	if (!state.token) {
		showFatal("Missing review token. Re-run /diff from Pi.");
		return;
	}

	try {
		const review = await apiGet("/api/review");
		state.review = review;
		indexLines(review);
		renderAll();
	} catch (error) {
		showFatal(error.message || String(error));
	}
}

function indexLines(review) {
	state.lineByKey.clear();
	for (const file of review.files) {
		for (const hunk of file.hunks) {
			for (const line of hunk.lines) {
				state.lineByKey.set(line.key, { file, hunk, line });
			}
		}
	}
}

function renderAll() {
	renderSubtitle();
	renderFileList();
	renderDiff();
	renderComments();
	updateButtons();

	if (state.focusLineKey) {
		const selector = `[data-comment-for="${cssEscape(state.focusLineKey)}"] textarea`;
		const textarea = document.querySelector(selector);
		textarea?.focus();
		state.focusLineKey = null;
	}
}

function renderSubtitle() {
	const { stats, cwd, gitCommand } = state.review;
	elements.subtitle.textContent = `${stats.files} files, ${stats.hunks} hunks, +${stats.added}/-${stats.deleted} · ${gitCommand} · ${cwd}`;
}

function renderFileList() {
	elements.fileList.replaceChildren();
	for (const file of state.review.files) {
		const link = document.createElement("a");
		link.href = `#file-${file.index}`;
		link.className = "file-link";
		const name = document.createElement("span");
		name.textContent = file.displayPath;
		const badge = document.createElement("span");
		badge.className = "badge";
		badge.textContent = fileBadge(file);
		link.append(name, badge);
		elements.fileList.append(link);
	}
}

function renderDiff() {
	elements.diffPane.replaceChildren();
	for (const file of state.review.files) {
		const section = document.createElement("section");
		section.className = "file-section";
		section.id = `file-${file.index}`;

		const header = document.createElement("div");
		header.className = "file-header";
		const title = document.createElement("h2");
		title.textContent = file.displayPath;
		const meta = document.createElement("div");
		meta.className = "file-summary";
		meta.textContent = fileSummary(file);
		header.append(title, meta);
		section.append(header);

		if (file.headerLines.length > 0) {
			const pre = document.createElement("pre");
			pre.className = "file-meta";
			pre.textContent = file.headerLines.join("\n");
			section.append(pre);
		}

		if (file.hunks.length === 0) {
			const empty = document.createElement("div");
			empty.className = "empty-file";
			empty.textContent = file.isBinary ? "Binary diff: no line comments available." : "No textual hunks in this file.";
			section.append(empty);
		}

		for (const hunk of file.hunks) {
			section.append(renderHunk(hunk));
		}

		elements.diffPane.append(section);
	}
}

function renderHunk(hunk) {
	const wrapper = document.createElement("div");
	wrapper.className = "hunk";

	const header = document.createElement("div");
	header.className = "hunk-header";
	header.textContent = hunk.header;
	wrapper.append(header);

	const table = document.createElement("table");
	table.className = "diff-table";
	const tbody = document.createElement("tbody");

	for (const line of hunk.lines) {
		tbody.append(renderLine(line));
		const comment = state.comments.get(line.key);
		if (comment) tbody.append(renderCommentRow(comment));
	}

	table.append(tbody);
	wrapper.append(table);
	return wrapper;
}

function renderLine(line) {
	const tr = document.createElement("tr");
	tr.className = `diff-line ${line.type}`;
	tr.dataset.lineKey = line.key;
	tr.title = "Click to add a comment";
	tr.addEventListener("click", () => addOrFocusComment(line.key));

	const commentCell = document.createElement("td");
	commentCell.className = "comment-gutter";
	const button = document.createElement("button");
	button.type = "button";
	button.className = state.comments.has(line.key) ? "comment-marker active" : "comment-marker";
	button.textContent = state.comments.has(line.key) ? "●" : "+";
	button.ariaLabel = "Add comment";
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		addOrFocusComment(line.key);
	});
	commentCell.append(button);

	const oldNo = document.createElement("td");
	oldNo.className = "line-no old";
	oldNo.textContent = line.oldLine ?? "";
	const newNo = document.createElement("td");
	newNo.className = "line-no new";
	newNo.textContent = line.newLine ?? "";
	const code = document.createElement("td");
	code.className = "code";
	const pre = document.createElement("pre");
	pre.textContent = line.raw || " ";
	code.append(pre);

	tr.append(commentCell, oldNo, newNo, code);
	return tr;
}

function renderCommentRow(comment) {
	const tr = document.createElement("tr");
	tr.className = "comment-row";
	tr.dataset.commentFor = comment.lineKey;
	const td = document.createElement("td");
	td.colSpan = 4;

	const box = document.createElement("div");
	box.className = "inline-comment";
	const label = document.createElement("div");
	label.className = "comment-label";
	label.textContent = commentLabel(comment.lineKey);

	const textarea = document.createElement("textarea");
	textarea.placeholder = "What should Pi fix or investigate on this line?";
	textarea.value = comment.body;
	textarea.rows = Math.max(2, Math.min(8, comment.body.split("\n").length + 1));
	textarea.addEventListener("click", (event) => event.stopPropagation());
	textarea.addEventListener("input", () => {
		comment.body = textarea.value;
		textarea.rows = Math.max(2, Math.min(8, textarea.value.split("\n").length + 1));
		renderComments();
		updateButtons();
	});

	const tools = document.createElement("div");
	tools.className = "comment-tools";
	const deleteButton = document.createElement("button");
	deleteButton.type = "button";
	deleteButton.className = "danger small";
	deleteButton.textContent = "Delete";
	deleteButton.addEventListener("click", () => {
		state.comments.delete(comment.lineKey);
		renderAll();
	});
	tools.append(deleteButton);

	box.append(label, textarea, tools);
	td.append(box);
	tr.append(td);
	return tr;
}

function renderComments() {
	const comments = Array.from(state.comments.values());
	const filled = nonEmptyComments();
	elements.commentCount.textContent = String(filled.length);
	elements.commentList.replaceChildren();
	elements.commentList.classList.toggle("empty", comments.length === 0);

	if (comments.length === 0) {
		elements.commentList.textContent = "No comments yet. Click a diff line to add one.";
		return;
	}

	for (const [index, comment] of comments.entries()) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = comment.body.trim() ? "comment-summary" : "comment-summary draft";
		item.addEventListener("click", () => scrollToLine(comment.lineKey));

		const title = document.createElement("strong");
		title.textContent = `C${index + 1} · ${commentLabel(comment.lineKey)}`;
		const body = document.createElement("span");
		body.textContent = comment.body.trim() || "Draft comment…";
		item.append(title, body);
		elements.commentList.append(item);
	}
}

function addOrFocusComment(lineKey) {
	if (!state.comments.has(lineKey)) state.comments.set(lineKey, { lineKey, body: "" });
	state.focusLineKey = lineKey;
	renderAll();
}

function updateButtons() {
	const count = nonEmptyComments().length;
	elements.submitButton.disabled = state.submitted || count === 0;
	elements.submitButton.textContent = count === 1 ? "Submit 1 comment" : `Submit ${count} comments`;
	elements.cancelButton.disabled = state.submitted;
}

async function submitReview() {
	const comments = nonEmptyComments();
	if (comments.length === 0) {
		showToast("Add at least one non-empty comment first.");
		return;
	}

	state.submitted = true;
	updateButtons();
	try {
		await apiPost("/api/submit", { comments });
		showToast("Submitted. Closing window…", 1200);
		document.body.classList.add("submitted");
		setTimeout(closeReviewWindow, 250);
	} catch (error) {
		state.submitted = false;
		updateButtons();
		showToast(error.message || String(error), 8000);
	}
}

async function cancelReview() {
	if (nonEmptyComments().length > 0 && !confirm("Cancel this review and discard comments?")) return;
	state.submitted = true;
	updateButtons();
	try {
		await apiPost("/api/cancel", {});
		showToast("Cancelled. You can close this window.", 8000);
		document.body.classList.add("submitted");
	} catch (error) {
		showToast(error.message || String(error), 8000);
	}
}

function closeReviewWindow() {
	window.open("", "_self");
	window.close();
	setTimeout(() => showToast("Submitted. You can close this window.", 8000), 800);
}

function nonEmptyComments() {
	return Array.from(state.comments.values())
		.map((comment) => ({ lineKey: comment.lineKey, body: comment.body.trim() }))
		.filter((comment) => comment.body.length > 0);
}

async function apiGet(path) {
	const response = await fetch(path, {
		headers: { "x-diff-review-token": state.token },
		cache: "no-store",
	});
	return readApiResponse(response);
}

async function apiPost(path, body) {
	const response = await fetch(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-diff-review-token": state.token,
		},
		body: JSON.stringify({ token: state.token, ...body }),
		cache: "no-store",
	});
	return readApiResponse(response);
}

async function readApiResponse(response) {
	const text = await response.text();
	let payload = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = { error: text || response.statusText };
	}
	if (!response.ok) throw new Error(payload?.error || response.statusText);
	return payload;
}

function scrollToLine(lineKey) {
	state.focusLineKey = lineKey;
	renderAll();
	requestAnimationFrame(() => {
		const row = document.querySelector(`[data-line-key="${cssEscape(lineKey)}"]`);
		row?.scrollIntoView({ block: "center", behavior: "smooth" });
		row?.classList.add("flash");
		setTimeout(() => row?.classList.remove("flash"), 1200);
	});
}

function commentLabel(lineKey) {
	const location = state.lineByKey.get(lineKey);
	if (!location) return "unknown line";
	const { file, line } = location;
	let linePart = "metadata";
	if (line.oldLine !== undefined && line.newLine !== undefined) linePart = `old ${line.oldLine} / new ${line.newLine}`;
	else if (line.newLine !== undefined) linePart = `new ${line.newLine}`;
	else if (line.oldLine !== undefined) linePart = `old ${line.oldLine}`;
	return `${file.displayPath} · ${linePart}`;
}

function fileBadge(file) {
	if (file.isBinary) return "binary";
	if (file.isNew) return "new";
	if (file.isDeleted) return "deleted";
	return `${file.hunks.length}`;
}

function fileSummary(file) {
	const flags = [];
	if (file.isNew) flags.push("new file");
	if (file.isDeleted) flags.push("deleted file");
	if (file.isBinary) flags.push("binary");
	flags.push(`${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}`);
	return flags.join(" · ");
}

function showFatal(message) {
	elements.subtitle.textContent = "Unable to load diff review.";
	elements.diffPane.replaceChildren();
	const fatal = document.createElement("div");
	fatal.className = "fatal";
	fatal.textContent = message;
	elements.diffPane.append(fatal);
}

function showToast(message, duration = 4000) {
	elements.toast.textContent = message;
	elements.toast.hidden = false;
	clearTimeout(showToast.timeout);
	showToast.timeout = setTimeout(() => {
		elements.toast.hidden = true;
	}, duration);
}

function cssEscape(value) {
	return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

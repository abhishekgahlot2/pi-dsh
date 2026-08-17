const state = {
	sessions: [],
	sessionFilter: "",
	selectedSessionId: null,
	session: null,
	view: "trajectory",
	category: "all",
	surface: "all",
	search: "",
	query: "",
	queryResults: [],
	queryTimer: null,
	selectedSeq: null,
	detailTab: "summary",
	eventSource: null,
	refreshTimer: null,
	lineage: null,
};

const ui = Object.fromEntries(
	[
		"session-list", "session-count", "session-search", "session-kicker", "session-title", "session-path",
		"session-metrics", "issues-banner", "event-search", "event-filters", "event-list", "event-detail",
		"view-chat", "view-trajectory", "live-dot", "live-label", "reload-button", "toast",
		"query-search", "surface-filter", "query-results",
	].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]),
);

const CATEGORY_ORDER = ["all", "operation", "request", "user", "assistant", "tool", "constraint", "extension", "compaction", "repair", "queue", "usage", "storage", "record"];

function node(tag, attributes = {}, children = []) {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined || value === null || value === false) continue;
		if (name === "className") element.className = value;
		else if (name === "text") element.textContent = value;
		else if (name.startsWith("on") && typeof value === "function") element.addEventListener(name.slice(2).toLowerCase(), value);
		else element.setAttribute(name, String(value));
	}
	for (const child of children) element.append(child);
	return element;
}

function formatTime(timestamp) {
	if (!timestamp) return "—";
	return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function formatDate(timestamp) {
	if (!timestamp) return "unknown";
	return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function formatBytes(bytes = 0) {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function shortId(id) {
	if (!id) return "—";
	return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function setLive(status, label) {
	ui.live_dot.className = `live-dot is-${status}`;
	ui.live_label.textContent = label;
}

function toast(message) {
	ui.toast.textContent = message;
	ui.toast.classList.add("is-visible");
	setTimeout(() => ui.toast.classList.remove("is-visible"), 2_000);
}

async function fetchJson(path) {
	const response = await fetch(path, { headers: { Accept: "application/json" } });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return response.json();
}

async function loadSessions({ select = true } = {}) {
	ui.reload_button.classList.add("is-spinning");
	try {
		const { sessions } = await fetchJson("/api/sessions");
		state.sessions = sessions;
		renderSessions();
		if (select) {
			const hashId = safeDecode(location.hash.slice(1));
			const preferred = state.selectedSessionId ?? (sessions.some(({ id }) => id === hashId) ? hashId : sessions[0]?.id);
			if (preferred) await selectSession(preferred);
		}
	} catch (error) {
		setLive("error", "viewer unavailable");
		toast(`Could not load sessions: ${error.message}`);
	} finally {
		ui.reload_button.classList.remove("is-spinning");
	}
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return "";
	}
}

async function selectSession(id) {
	if (!id) return;
	state.selectedSessionId = id;
	state.selectedSeq = null;
	location.hash = encodeURIComponent(id);
	renderSessions();
	setLive("loading", "reading durable log");
	try {
		await loadSelectedSession();
		await loadLineage();
		followSelectedSession();
	} catch (error) {
		setLive("error", "read failed");
		toast(`Could not read ${id}: ${error.message}`);
	}
}

async function loadSelectedSession({ preserveSelection = false } = {}) {
	const id = state.selectedSessionId;
	if (!id) return;
	const session = await fetchJson(`/api/sessions/${encodeURIComponent(id)}`);
	state.session = session;
	if (!preserveSelection || !session.events.some(({ seq }) => seq === state.selectedSeq)) {
		state.selectedSeq = session.events.at(-1)?.seq ?? null;
	}
	renderSession();
	renderQueryResults();
	setLive("live", "following durable writes");
}

async function loadLineage() {
	const id = state.selectedSessionId;
	if (!id) return;
	try {
		state.lineage = await fetchJson(`/api/sessions/${encodeURIComponent(id)}/lineage`);
	} catch {
		state.lineage = null;
	}
	renderSession();
}

function followSelectedSession() {
	state.eventSource?.close();
	if (!state.selectedSessionId) return;
	const source = new EventSource(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/events`);
	state.eventSource = source;
	source.addEventListener("ready", () => setLive("live", "following durable writes"));
	source.addEventListener("change", () => {
		clearTimeout(state.refreshTimer);
		state.refreshTimer = setTimeout(async () => {
			try {
				await Promise.all([loadSelectedSession({ preserveSelection: true }), loadSessions({ select: false })]);
				ui.live_dot.classList.add("did-pulse");
				setTimeout(() => ui.live_dot.classList.remove("did-pulse"), 500);
			} catch (error) {
				setLive("error", "live refresh failed");
			}
		}, 120);
	});
	source.onerror = () => setLive("loading", "reconnecting…");
}

function renderSessions() {
	const query = state.sessionFilter.toLowerCase();
	const sessions = state.sessions.filter((session) => `${session.id} ${session.cwd ?? ""}`.toLowerCase().includes(query));
	ui.session_count.textContent = String(state.sessions.length);
	ui.session_list.replaceChildren();
	if (sessions.length === 0) {
		ui.session_list.append(node("div", { className: "empty-list", text: state.sessions.length ? "No matching sessions" : "No durable sessions yet" }));
		return;
	}
	const fragment = document.createDocumentFragment();
	for (const session of sessions) {
		const active = session.id === state.selectedSessionId;
		const button = node("button", {
			className: `session-row${active ? " is-active" : ""}`,
			type: "button",
			"aria-current": active ? "page" : undefined,
			onClick: () => void selectSession(session.id),
		}, [
			node("span", { className: `session-health is-${session.corruptionState}`, title: session.corruptionState }),
			node("span", { className: "session-copy" }, [
				node("strong", { text: shortId(session.id), title: session.id }),
				node("small", { text: session.cwd ?? session.error ?? "header unavailable" }),
			]),
			node("span", { className: "session-meta" }, [
				node("time", { text: formatDate(session.modifiedAt) }),
				node("small", { text: formatBytes(session.sizeBytes) }),
			]),
		]);
		fragment.append(button);
	}
	ui.session_list.append(fragment);
}

function renderSession() {
	const { session } = state;
	if (!session) return;
	ui.session_kicker.textContent = `session / ${shortId(session.summary.id)}`;
	ui.session_title.textContent = state.view === "trajectory" ? "Durable event ledger" : "Model-visible conversation";
	ui.session_path.textContent = session.header?.cwd ?? "Session header unavailable";
	ui.session_metrics.replaceChildren(
		metric("events", session.events.length),
		metric("messages", session.chat.length),
		metric("bytes", formatBytes(session.summary.sizeBytes)),
		metric("state", session.summary.corruptionState),
		metric("lineage", state.lineage?.lineage?.length ?? 1),
	);
	renderIssues();
	renderFilters();
	renderLedger();
	renderDetail();
	renderQueryResults();
}

function metric(label, value) {
	return node("div", { className: "metric" }, [node("strong", { text: String(value) }), node("span", { text: label })]);
}

function renderIssues() {
	const { session } = state;
	const messages = session.issues.map(({ line, message }) => `Line ${line}: ${message}`);
	if (session.uncommittedTail !== undefined) messages.push(`${formatBytes(session.summary.uncommittedTailBytes)} uncommitted tail excluded`);
	ui.issues_banner.hidden = messages.length === 0;
	ui.issues_banner.replaceChildren(
		node("strong", { text: session.issues.length ? "Log integrity warning" : "Uncommitted write observed" }),
		node("span", { text: messages.join(" · ") }),
	);
}

function renderFilters() {
	ui.event_filters.replaceChildren();
	if (state.view === "chat") {
		ui.event_filters.append(node("span", { className: "filter-context", text: `${state.session.chat.length} projected messages` }));
		return;
	}
	const counts = Object.groupBy(state.session.events, ({ category }) => category);
	for (const category of CATEGORY_ORDER) {
		const count = category === "all" ? state.session.events.length : counts[category]?.length ?? 0;
		if (category !== "all" && count === 0) continue;
		ui.event_filters.append(node("button", {
			className: `filter-chip${state.category === category ? " is-active" : ""}`,
			type: "button",
			text: `${category} ${count}`,
			onClick: () => { state.category = category; renderFilters(); renderLedger(); },
		}));
	}
}

function filteredEvents() {
	const query = state.search.toLowerCase().trim();
	return state.session.events.filter((event) => {
		if (state.category !== "all" && event.category !== state.category) return false;
		if (state.surface !== "all" && event.surface !== state.surface) return false;
		return !query || event.searchText.includes(query) || JSON.stringify(event.payload).toLowerCase().includes(query);
	});
}

function renderQueryResults() {
	if (!ui.query_results) return;
	ui.query_results.replaceChildren();
	if (!state.query.trim()) {
		ui.query_results.hidden = true;
		return;
	}
	ui.query_results.hidden = false;
	if (state.queryResults.length === 0) {
		ui.query_results.append(node("span", { className: "query-empty", text: "No query citations" }));
		return;
	}
	ui.query_results.append(...state.queryResults.slice(0, 8).map((result) => node("button", {
		type: "button",
		className: `query-result is-${result.event.surface ?? "log-only"}`,
		title: `${result.sessionId} seq ${result.event.seq} line ${result.event.line}`,
		onClick: async () => {
			if (result.sessionId === state.selectedSessionId) selectEvent(result.event.seq);
			else {
				await selectSession(result.sessionId);
				selectEvent(result.event.seq);
			}
		},
	}, [
		node("span", { text: result.event.surface ?? "log-only" }),
		node("strong", { text: result.event.label }),
		node("small", { text: `${shortId(result.sessionId)}:${result.event.seq}` }),
	])));
}

function renderLedger() {
	ui.event_list.replaceChildren();
	const rows = state.view === "trajectory" ? filteredEvents() : filteredChat();
	if (rows.length === 0) {
		ui.event_list.append(node("div", { className: "ledger-empty" }, [
			node("span", { text: "∅" }),
			node("strong", { text: state.search ? "Nothing matches this query" : "No durable events yet" }),
		]));
		return;
	}
	const fragment = document.createDocumentFragment();
	for (const row of rows) fragment.append(state.view === "trajectory" ? eventRow(row) : chatRow(row));
	ui.event_list.append(fragment);
}

function filteredChat() {
	const query = state.search.toLowerCase().trim();
	return state.session.chat.filter((item) => !query || `${item.role} ${item.summary} ${item.entryId}`.toLowerCase().includes(query));
}

function eventRow(event) {
	const selected = event.seq === state.selectedSeq;
	return node("button", {
		className: `event-row category-${event.category}${selected ? " is-selected" : ""}`,
		type: "button",
		"data-seq": event.seq,
		"aria-pressed": selected,
		onClick: () => selectEvent(event.seq),
	}, [
		node("span", { className: "event-seq", text: String(event.seq).padStart(4, "0") }),
		node("span", { className: "event-track" }, [node("span", { className: "event-node" }), node("span", { className: "event-line" })]),
		node("span", { className: "event-body" }, [
			node("span", { className: "event-labels" }, [
				node("span", { className: `source-badge is-${event.category}`, text: event.category }),
				node("span", { className: `surface-badge is-${event.surface ?? "log-only"}`, text: event.surface ?? "log-only" }),
				node("strong", { text: event.label }),
				event.lane ? node("small", { text: event.lane }) : node("span"),
			]),
			node("span", { className: "event-summary", text: event.summary }),
		]),
		node("time", { className: "event-time", text: formatTime(event.timestamp), datetime: event.timestamp ? new Date(event.timestamp).toISOString() : undefined }),
	]);
}

function chatRow(item) {
	const selected = item.seq === state.selectedSeq;
	return node("button", {
		className: `chat-row is-${item.role}${item.isError ? " is-error" : ""}${selected ? " is-selected" : ""}`,
		type: "button",
		"data-seq": item.seq,
		"aria-pressed": selected,
		onClick: () => selectEvent(item.seq),
	}, [
		node("span", { className: "chat-author", text: item.role === "toolResult" ? "tool" : item.role }),
		node("span", { className: "chat-content" }, [node("span", { text: item.summary }), item.toolCallId ? node("code", { text: item.toolCallId }) : node("span")]),
		node("time", { text: formatTime(item.timestamp) }),
	]);
}

function selectEvent(seq) {
	state.selectedSeq = seq;
	renderLedger();
	renderDetail();
}

function selectedEvent() {
	return state.session?.events.find(({ seq }) => seq === state.selectedSeq) ?? null;
}

function renderDetail() {
	const event = selectedEvent();
	if (!event) {
		ui.event_detail.replaceChildren(node("div", { className: "detail-empty" }, [
			node("span", { className: "detail-glyph", text: "⌁" }), node("strong", { text: "Select an event" }),
			node("p", { text: "Inspect its exact durable payload and correlations." }),
		]));
		return;
	}
	const tabs = ["summary", "payload", "schema", "timing"];
	const tabBar = node("div", { className: "detail-tabs", role: "tablist", "aria-label": "Detail view" }, tabs.map((tab) => node("button", {
		type: "button", role: "tab", text: tab, className: state.detailTab === tab ? "is-active" : "",
		"aria-selected": state.detailTab === tab,
		onClick: () => { state.detailTab = tab; renderDetail(); },
	})));
	ui.event_detail.replaceChildren(
		node("div", { className: "detail-header" }, [
			node("span", { className: `detail-icon is-${event.category}`, text: event.category.slice(0, 2).toUpperCase() }),
			node("div", {}, [node("span", { className: "eyebrow", text: `seq ${event.seq} · line ${event.line}` }), node("h3", { text: event.label })]),
		]),
		tabBar,
		detailContent(event),
	);
}

function detailContent(event) {
	if (state.detailTab === "payload") return node("pre", { className: "payload-view", text: JSON.stringify(event.payload, null, 2) });
	if (state.detailTab === "schema") return node("pre", { className: "payload-view schema-view", text: JSON.stringify(schemaOf(event.payload), null, 2) });
	if (state.detailTab === "timing") return definitionList([
		["recorded", event.timestamp ? new Date(event.timestamp).toLocaleString() : "not timestamped"], ["epoch ms", event.timestamp ?? "—"],
		["sequence", event.seq], ["physical line", event.line], ["lane", event.lane ?? "—"], ["run", event.runId ?? "—"],
	]);
	return node("div", { className: "summary-view" }, [
		node("p", { className: "detail-summary", text: event.summary }),
		definitionList([
			["kind", event.kind],
			["category", event.category],
			["surface", event.surface ?? "log-only"],
			["id", event.id ?? "—"],
			["parent", event.parentId ?? "—"],
			["tool call", event.toolCallId ?? "—"],
			["replaces", event.replacesSeqs?.join(", ") || "—"],
			["sources", event.sourceSeqs?.join(", ") || "—"],
			["derived", event.derivedSeqs?.join(", ") || "—"],
		]),
		node("div", { className: "detail-actions" }, [
			node("button", { className: "correlation", type: "button", text: "read event window", onClick: () => void inspectWindow(event.seq) }),
			node("button", { className: "correlation", type: "button", text: "trace event", onClick: () => void inspectTrace(event.seq) }),
		]),
		event.correlationId ? node("button", { className: "correlation", type: "button", text: `trace correlation · ${shortId(event.correlationId)}`, onClick: () => traceCorrelation(event.correlationId) }) : node("span"),
	]);
}

function definitionList(items) {
	return node("dl", { className: "definition-list" }, items.flatMap(([term, value]) => [node("dt", { text: String(term) }), node("dd", { text: String(value), title: String(value) })]));
}

function schemaOf(value) {
	if (Array.isArray(value)) return value.length ? [schemaOf(value[0])] : [];
	if (value === null) return "null";
	if (typeof value !== "object") return typeof value;
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, schemaOf(child)]));
}

function traceCorrelation(id) {
	state.view = "trajectory";
	state.category = "all";
	state.search = id;
	ui.event_search.value = id;
	setView("trajectory");
}

async function inspectWindow(seq) {
	if (!state.selectedSessionId) return;
	try {
		const windowResult = await fetchJson(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/events/${seq}/window?before=3&after=3`);
		state.query = `window:${seq}`;
		ui.query_search.value = state.query;
		state.queryResults = windowResult.events.map((event) => ({
			sessionId: windowResult.sessionId,
			event,
			citation: { sessionId: windowResult.sessionId, seq: event.seq, line: event.line },
		}));
		renderQueryResults();
	} catch (error) {
		toast(`Could not read event window: ${error.message}`);
	}
}

async function inspectTrace(seq) {
	if (!state.selectedSessionId) return;
	try {
		const trace = await fetchJson(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/events/${seq}/trace`);
		state.query = `trace:${seq}`;
		ui.query_search.value = state.query;
		state.queryResults = trace.events.map((event) => ({
			sessionId: trace.sessionId,
			event,
			citation: { sessionId: trace.sessionId, seq: event.seq, line: event.line },
		}));
		renderQueryResults();
	} catch (error) {
		toast(`Could not trace event: ${error.message}`);
	}
}

function scheduleQuerySearch() {
	clearTimeout(state.queryTimer);
	state.queryTimer = setTimeout(() => {
		void runQuerySearch();
	}, 150);
}

async function runQuerySearch() {
	const query = state.query.trim();
	if (!query || query.startsWith("window:") || query.startsWith("trace:")) {
		state.queryResults = [];
		renderQueryResults();
		return;
	}
	const params = new URLSearchParams({ q: query, limit: "40" });
	if (state.selectedSessionId) params.set("session", state.selectedSessionId);
	if (state.surface !== "all") params.set("surface", state.surface);
	try {
		const response = await fetchJson(`/api/query/search?${params.toString()}`);
		state.queryResults = response.results;
		renderQueryResults();
	} catch (error) {
		state.queryResults = [];
		renderQueryResults();
		toast(`Query failed: ${error.message}`);
	}
}

function setView(view) {
	state.view = view;
	ui.view_chat.classList.toggle("is-active", view === "chat");
	ui.view_trajectory.classList.toggle("is-active", view === "trajectory");
	ui.view_chat.setAttribute("aria-selected", String(view === "chat"));
	ui.view_trajectory.setAttribute("aria-selected", String(view === "trajectory"));
	if (state.session) renderSession();
}

ui.view_chat.addEventListener("click", () => setView("chat"));
ui.view_trajectory.addEventListener("click", () => setView("trajectory"));
ui.session_search.addEventListener("input", (event) => { state.sessionFilter = event.target.value; renderSessions(); });
ui.event_search.addEventListener("input", (event) => { state.search = event.target.value; renderLedger(); });
ui.query_search.addEventListener("input", (event) => { state.query = event.target.value; scheduleQuerySearch(); });
ui.surface_filter.addEventListener("change", (event) => {
	state.surface = event.target.value;
	renderLedger();
	scheduleQuerySearch();
});
ui.reload_button.addEventListener("click", () => {
	void (async () => {
		await loadSessions({ select: false });
		if (state.selectedSessionId) await loadSelectedSession({ preserveSelection: true });
	})();
});
ui.event_list.addEventListener("keydown", (event) => {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const rows = state.view === "trajectory" ? filteredEvents() : filteredChat();
	const index = Math.max(0, rows.findIndex(({ seq }) => seq === state.selectedSeq));
	const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
	if (next) { event.preventDefault(); selectEvent(next.seq); ui.event_list.querySelector(`[data-seq="${next.seq}"]`)?.scrollIntoView({ block: "nearest" }); }
});
document.addEventListener("keydown", (event) => {
	if (event.key === "/" && document.activeElement?.tagName !== "INPUT") { event.preventDefault(); ui.event_search.focus(); }
	if (event.key === "Escape" && document.activeElement === ui.event_search) { ui.event_search.value = ""; state.search = ""; ui.event_search.blur(); renderLedger(); }
});
window.addEventListener("beforeunload", () => {
	clearTimeout(state.refreshTimer);
	clearTimeout(state.queryTimer);
	state.eventSource?.close();
});

void loadSessions();

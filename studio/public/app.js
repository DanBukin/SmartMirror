"use strict";

// SmartMirror Studio — клиент. Без сборки и зависимостей,
// чтобы потом легко завернуть в мобильное приложение (Capacitor / WebView).

const api = {
	async get (path) {
		const r = await fetch(path);
		if (!r.ok) throw new Error((await r.json()).error || r.statusText);
		return r.json();
	},
	async send (method, path, body) {
		const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		const data = await r.json();
		if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status, data });
		return data;
	}
};

const state = {
	catalog: null,
	layout: null,
	revision: 0,
	appliedRevision: 0,
	selectedId: null,
	saving: false,
	saveTimer: null,
	view: "scheme",
	mirror: null,
	measured: {}, // настоящие места виджетов на живом зеркале (доли экрана), от MMM-StudioBridge
	missing: new Map(), // сторонние модули из макета, которые ещё не установлены: имя → ссылка
	installing: null
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") node.className = v;
		else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else if (k === "text") node.textContent = v;
		else node.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
	return node;
};

const widgetDef = (type) => state.catalog.widgets.find((w) => w.type === type);
const positionLabel = (id) => state.catalog.positions.find((p) => p.id === id)?.label ?? id;
const repoModule = (repo) => (String(repo).match(/^https:\/\/github\.com\/[\w.-]+\/([\w-]+?)(?:\.git)?\/?$/) || [])[1] || null;
const widgetModule = (w) => (widgetDef(w.type).custom ? repoModule(w.options.repo) : widgetDef(w.type).module);
const isMissing = (w) => state.missing.has(widgetModule(w));
const selected = () => state.layout.widgets.find((w) => w.id === state.selectedId) || null;
const isFree = () => state.layout.placement === "free";
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

// ---------- размер экрана ----------

const CM_PER_IN = 2.54;

/** Физический размер экрана в сантиметрах и размер страницы зеркала в пикселях (короткая сторона 1080). */
function screenGeometry (s = state.layout.screen) {
	const k = s.unit === "in" ? CM_PER_IN : 1;
	let long, short;
	if (s.sizeMode === "size") {
		long = Math.max(s.width, s.height) * k;
		short = Math.min(s.width, s.height) * k;
	} else {
		const [a, b] = s.aspect.split(":").map(Number);
		const unit = (s.diagonal * k) / Math.hypot(a, b);
		long = a * unit;
		short = b * unit;
	}
	const portrait = s.orientation === "portrait";
	const longPx = Math.round((1080 * long) / short);
	return {
		wCm: portrait ? short : long,
		hCm: portrait ? long : short,
		diagCm: Math.hypot(long, short),
		px: portrait ? [1080, longPx] : [longPx, 1080]
	};
}

/** Длина в единицах экрана: «12,5 см» или «4,9″». */
function fmtLen (cm, unit = state.layout.screen.unit) {
	const v = unit === "in" ? cm / CM_PER_IN : cm;
	return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}${unit === "in" ? "″" : " см"}`;
}

/** Ближайшее стандартное соотношение сторон для размеров long × short. */
function nearestAspect (long, short) {
	const options = state.catalog.screen.find((f) => f.key === "aspect").options;
	const ratio = long / short;
	return options.reduce((best, o) => {
		const [a, b] = o.value.split(":").map(Number);
		return Math.abs(a / b - ratio) < Math.abs(best.r - ratio) ? { v: o.value, r: a / b } : best;
	}, { v: "16:9", r: 16 / 9 }).v;
}

/** Подгоняет схему и живой экран под пропорции экрана. */
function applyScreen () {
	const g = screenGeometry();
	for (const node of [$("#board"), $("#live")]) {
		node.style.aspectRatio = `${g.wCm} / ${g.hCm}`;
		node.style.width = `min(100%, calc(76vh * ${g.wCm / g.hCm}))`;
	}
	// сетка свободной раскладки: шаг 5 см или 2 дюйма
	const step = state.layout.screen.unit === "in" ? 2 * CM_PER_IN : 5;
	$("#board").style.setProperty("--grid-x", `${(100 * step) / g.wCm}%`);
	$("#board").style.setProperty("--grid-y", `${(100 * step) / g.hCm}%`);
	document.querySelectorAll("[data-orient]").forEach((b) => b.classList.toggle("active", b.dataset.orient === state.layout.screen.orientation));
	document.querySelectorAll("[data-placement]").forEach((b) => b.classList.toggle("active", b.dataset.placement === state.layout.placement));
	requestAnimationFrame(fitLive);
}

function toast (msg, kind = "") {
	const t = $("#toast");
	t.textContent = msg;
	t.className = `toast show ${kind}`;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => (t.className = "toast"), 3200);
}

// ---------- сохранение ----------

function changed ({ rerender = true } = {}) {
	clearTimeout(state.saveTimer);
	state.saving = true;
	state.saveTimer = setTimeout(save, 400);
	if (rerender) renderBoard();
	renderApply();
}

async function save () {
	try {
		const res = await api.send("PUT", "/api/layout", { baseRevision: state.revision, layout: state.layout });
		state.revision = res.revision;
		state.appliedRevision = res.appliedRevision;
		await refreshModules();
	} catch (err) {
		if (err.status === 409) {
			Object.assign(state, { layout: err.data.layout, revision: err.data.revision, appliedRevision: err.data.appliedRevision });
			toast("Макет изменили с другого устройства — загружена свежая версия", "warn");
			renderAll();
		} else toast(`Не удалось сохранить: ${err.message}`, "error");
	} finally {
		state.saving = false;
		renderApply();
	}
}

async function refreshModules () {
	const res = await api.get("/api/modules");
	const before = [...state.missing.keys()].join();
	state.missing = new Map(res.missing.map((m) => [m.module, m.repo]));
	if (before !== [...state.missing.keys()].join()) {
		renderBoard();
		renderWidgetTab();
	}
}

/** Ставит модуль с GitHub; возвращает true при успехе. */
async function installModule (repo, title) {
	if (state.installing) return false;
	state.installing = repo;
	renderWidgetTab();
	renderAddTab();
	toast(`Устанавливаю «${title}» с GitHub… это может занять минуту`);
	try {
		const res = await api.send("POST", "/api/modules/install", { repo });
		toast(`«${title}» установлен`, "ok");
		state.catalog = await api.get("/api/catalog");
		return Boolean(res.ok);
	} catch (err) {
		toast(`Не удалось установить: ${err.message}`, "error");
		const log = err.data?.log?.slice(-15).join("\n");
		if (log) $("#logs").textContent = log;
		return false;
	} finally {
		state.installing = null;
		await refreshModules();
		renderAddTab();
		renderWidgetTab();
		renderBoard();
	}
}

async function applyToMirror () {
	if (state.saving) {
		clearTimeout(state.saveTimer);
		await save();
	}
	const btn = $("#applyBtn");
	btn.disabled = true;
	btn.textContent = "Перезапуск…";
	setMirrorStatus({ state: "starting" });
	try {
		const res = await api.send("POST", "/api/apply");
		state.revision = res.revision;
		state.appliedRevision = res.appliedRevision;
		toast("Готово: зеркало обновлено", "ok");
		reloadLive();
	} catch (err) {
		toast(`Ошибка применения: ${err.message}`, "error");
	} finally {
		btn.textContent = "Применить";
		renderApply();
		pollMirror();
	}
}

function renderApply () {
	const dirty = state.saving || state.revision !== state.appliedRevision;
	const btn = $("#applyBtn");
	btn.disabled = !dirty;
	btn.classList.toggle("pulse", dirty);
	btn.title = dirty ? "Есть изменения, которых ещё нет на зеркале" : "Зеркало показывает текущий макет";
}

// ---------- статус зеркала ----------

const STATUS_TEXT = { running: "Зеркало онлайн", starting: "Перезапуск…", stopped: "Остановлено", error: "Ошибка" };

function setMirrorStatus (s) {
	const box = $("#mirrorStatus");
	box.dataset.state = s.state;
	$(".label", box).textContent = (STATUS_TEXT[s.state] || s.state) + (s.demo ? " · демо" : "");
	box.title = s.lastError || (s.demo ? "Погода, календарь и новости — виртуальные демо-данные" : "");
	$("#mirrorError").hidden = s.state !== "error";
	$("#mirrorErrorText").textContent = s.lastError || "";
}

async function restartMirror () {
	setMirrorStatus({ state: "starting" });
	try {
		await api.send("POST", "/api/mirror/restart");
		toast("Зеркало перезапущено", "ok");
		reloadLive();
	} catch (err) {
		toast(`Не запустилось: ${err.message}`, "error");
		showTab("logs");
	}
	pollMirror();
}

async function pollMirror () {
	try {
		const prev = state.mirror?.state;
		const prevPort = state.mirror?.port;
		state.mirror = await api.get("/api/mirror");
		setMirrorStatus(state.mirror);
		// зеркало только что поднялось — обновляем живой экран
		if ((prev && prev !== "running" && state.mirror.state === "running") || (prevPort && prevPort !== state.mirror.port)) reloadLive();
		$("#openMirror").href = mirrorUrl();
	} catch {
		setMirrorStatus({ state: "error", lastError: "Studio недоступна" });
	}
}

// ---------- доска зеркала ----------

const REGIONS = [
	["top_bar", "bar"],
	["top_left", "tl"], ["top_center", "tc"], ["top_right", "tr"],
	["upper_third", "upper"],
	["middle_center", "middle"],
	["lower_third", "lower"],
	["bottom_left", "bl"], ["bottom_center", "bc"], ["bottom_right", "br"],
	["bottom_bar", "bbar"]
];

function renderBoard () {
	const board = $("#board");
	board.classList.toggle("free", isFree());
	if (isFree()) return renderFree();
	board.replaceChildren();
	for (const [pos, area] of REGIONS) {
		const widgets = state.layout.widgets.filter((w) => w.position === pos);
		const region = el("div", { class: `region ${widgets.length ? "" : "empty"}`, "data-pos": pos, style: `grid-area:${area}` },
			el("span", { class: "region-label", text: positionLabel(pos) }),
			el("div", { class: "slot" }, widgets.map(chip)));
		board.append(region);
	}
}

function chip (w) {
	const def = widgetDef(w.type);
	const title = w.header || def.title;
	return el("div", {
		class: `chip ${w.id === state.selectedId ? "selected" : ""} ${w.enabled ? "" : "off"}`,
		"data-id": w.id,
		role: "button",
		tabindex: "0",
		"aria-label": `${title}, ${positionLabel(w.position)}`,
		onpointerdown: startDrag,
		onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(w.id); } }
	},
	el("span", { class: "chip-icon", text: def.icon }),
	el("span", { class: "chip-text" },
		el("span", { class: "chip-title", text: title }),
		w.header && w.header !== def.title ? el("span", { class: "chip-sub", text: def.title }) : null),
	!w.enabled ? el("span", { class: "chip-badge", text: "скрыт" })
		: isMissing(w) ? el("span", { class: "chip-badge", text: "не установлен" }) : null);
}

// Перетаскивание на pointer-событиях: работает и мышью, и пальцем.
let drag = null;

function startDrag (e) {
	if (e.button !== 0) return;
	const node = e.currentTarget;
	drag = { id: node.dataset.id, node, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId };
	node.setPointerCapture(e.pointerId);
	node.addEventListener("pointermove", onDragMove);
	node.addEventListener("pointerup", endDrag);
	node.addEventListener("pointercancel", cancelDrag);
}

function onDragMove (e) {
	if (!drag) return;
	if (!drag.active) {
		if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
		drag.active = true;
		const rect = drag.node.getBoundingClientRect();
		drag.offsetX = drag.startX - rect.left;
		drag.offsetY = drag.startY - rect.top;
		drag.ghost = drag.node.cloneNode(true);
		drag.ghost.classList.add("ghost");
		drag.ghost.style.width = `${rect.width}px`;
		document.body.append(drag.ghost);
		drag.placeholder = el("div", { class: "placeholder" });
		drag.placeholder.style.height = `${rect.height}px`;
		drag.node.classList.add("dragging");
		document.body.classList.add("is-dragging");
	}
	drag.ghost.style.transform = `translate(${e.clientX - drag.offsetX}px, ${e.clientY - drag.offsetY}px)`;

	const under = document.elementFromPoint(e.clientX, e.clientY);
	const region = under?.closest(".region");
	document.querySelectorAll(".region.over").forEach((r) => r !== region && r.classList.remove("over"));
	if (!region) {
		drag.placeholder.remove();
		drag.target = null;
		return;
	}
	region.classList.add("over");
	const slot = $(".slot", region);
	const others = [...slot.querySelectorAll(".chip")].filter((c) => c !== drag.node);
	let index = others.findIndex((c) => {
		const r = c.getBoundingClientRect();
		return e.clientY < r.top + r.height / 2;
	});
	if (index === -1) index = others.length;
	slot.insertBefore(drag.placeholder, others[index] || null);
	drag.target = { pos: region.dataset.pos, index };
}

function endDrag () {
	const d = drag;
	cleanupDrag();
	if (!d) return;
	if (!d.active) return select(d.id);
	if (d.target) {
		moveWidget(d.id, d.target.pos, d.target.index);
		select(d.id, { switchTab: false });
		changed();
	} else renderBoard();
}

function cancelDrag () {
	cleanupDrag();
	renderBoard();
}

function cleanupDrag () {
	if (!drag) return;
	drag.node.removeEventListener("pointermove", onDragMove);
	drag.node.removeEventListener("pointerup", endDrag);
	drag.node.removeEventListener("pointercancel", cancelDrag);
	drag.ghost?.remove();
	drag.placeholder?.remove();
	drag.node.classList.remove("dragging");
	document.body.classList.remove("is-dragging");
	document.querySelectorAll(".region.over").forEach((r) => r.classList.remove("over"));
	drag = null;
}

/** Ставит виджет в зону pos на место index (среди виджетов этой зоны). */
function moveWidget (id, pos, index) {
	const list = state.layout.widgets;
	const w = list.splice(list.findIndex((x) => x.id === id), 1)[0];
	w.position = pos;
	const inPos = list.filter((x) => x.position === pos);
	if (index < inPos.length) list.splice(list.indexOf(inPos[index]), 0, w);
	else if (inPos.length) list.splice(list.indexOf(inPos[inPos.length - 1]) + 1, 0, w);
	else list.push(w);
}

function shiftWidget (w, delta) {
	const inPos = state.layout.widgets.filter((x) => x.position === w.position);
	const i = inPos.indexOf(w) + delta;
	if (i < 0 || i >= inPos.length) return;
	moveWidget(w.id, w.position, i);
	changed();
	renderWidgetTab();
}

// ---------- свободная раскладка ----------
// Виджет ставится в любую точку экрана. Место хранится в долях экрана (x, y — левый
// верхний угол, w — ширина), поэтому раскладка не ломается при смене размера монитора.
// Высоту задаёт содержимое виджета: берём её с живого зеркала, а пока его нет — примерную.

/** Выравнивание текста, как в зоне MagicMirror²: справа — по правому краю, в середине — по центру. */
const regionAlign = (pos) => (pos.endsWith("_right") ? "right" : pos.endsWith("_left") ? "left" : "center");

/** Место виджета по умолчанию: где он стоит на живом зеркале или где обычно его зона. */
function defaultFree (w) {
	const align = regionAlign(w.position);
	const spot = state.catalog.positions.find((p) => p.id === w.position)?.spot ?? { x: 0.04, y: 0.03, w: 0.4 };
	const m = state.measured[w.id];
	if (m) {
		// на зеркале многие виджеты узкие, по содержимому; даём запас ширины, сохраняя край выравнивания
		const width = clamp(Math.max(m.w, Math.min(0.4, spot.w)), 0.05, 1);
		const x = align === "right" ? m.x + m.w - width : align === "center" ? m.x + m.w / 2 - width / 2 : m.x;
		return { x: round(clamp(x, 0, 1 - width), 4), y: round(clamp(m.y, 0, 0.98), 4), w: round(width, 4), align };
	}
	const before = state.layout.widgets.filter((x) => x.position === w.position);
	const offset = before.slice(0, Math.max(0, before.indexOf(w))).reduce((sum, x) => sum + boxHeight(x) + 0.01, 0);
	return { ...spot, y: round(clamp(spot.y + offset, 0, 0.95), 4), align };
}

/**
 * Виджеты одной зоны стоят друг под другом. Если зеркало измерило их, пока данные ещё
 * грузились, высоты занижены — раздвигаем соседей, чтобы они не наложились.
 */
function unstack (widgets) {
	const h = (w) => Math.max(state.measured[w.id]?.h ?? 0, widgetDef(w.type).boxHeight / screenGeometry().px[1]);
	for (const pos of new Set(widgets.map((w) => w.position))) {
		const group = widgets.filter((w) => w.position === pos).sort((a, b) => a.free.y - b.free.y);
		for (let i = 1; i < group.length; i++) {
			const prev = group[i - 1].free;
			group[i].free.y = round(clamp(Math.max(group[i].free.y, prev.y + h(group[i - 1]) + 0.005), 0, 0.98), 4);
		}
	}
}

/** Высота виджета в долях высоты экрана. */
function boxHeight (w) {
	const m = state.measured[w.id];
	if (m && state.layout.placement === "free") return m.h;
	return widgetDef(w.type).boxHeight / screenGeometry().px[1];
}

function setPlacement (placement) {
	if (placement === state.layout.placement) return;
	if (placement === "free") {
		const fresh = state.layout.widgets.filter((w) => !w.free);
		for (const w of fresh) w.free = defaultFree(w);
		unstack(fresh);
	}
	state.layout.placement = placement;
	applyScreen();
	changed();
	renderWidgetTab();
	setView("scheme");
	toast(placement === "free" ? "Свободная раскладка: двигайте виджеты по экрану, тяните за правый край, чтобы изменить ширину" : "Раскладка по зонам MagicMirror²");
}

function renderFree () {
	const board = $("#board");
	board.replaceChildren(el("div", { class: "center-guide" }), ...state.layout.widgets.map(freeBox));
}

function freeBox (w) {
	const def = widgetDef(w.type);
	const f = w.free ||= defaultFree(w);
	const title = w.header || def.title;
	const box = el("div", {
		class: `fbox ${w.id === state.selectedId ? "selected" : ""} ${w.enabled ? "" : "off"}`,
		"data-id": w.id,
		role: "button",
		tabindex: "0",
		"aria-label": `${title}: ${fmtLen(f.x * screenGeometry().wCm)} от левого края, ${fmtLen(f.y * screenGeometry().hCm)} от верха`,
		onpointerdown: startFreeDrag,
		onkeydown: (e) => freeKey(e, w)
	},
	el("span", { class: "chip-icon", text: def.icon }),
	el("span", { class: "chip-text" },
		el("span", { class: "chip-title", text: title }),
		el("span", { class: "chip-sub fbox-size" })),
	!w.enabled ? el("span", { class: "chip-badge", text: "скрыт" })
		: isMissing(w) ? el("span", { class: "chip-badge", text: "не установлен" }) : null,
	el("span", { class: "fbox-resize", title: "Ширина виджета", "aria-hidden": "true" }));
	placeBox(box, w);
	return box;
}

function placeBox (box, w) {
	const f = w.free;
	const g = screenGeometry();
	box.style.left = `${f.x * 100}%`;
	box.style.top = `${f.y * 100}%`;
	box.style.width = `${f.w * 100}%`;
	box.style.height = `${Math.min(boxHeight(w), 1 - f.y) * 100}%`;
	$(".fbox-size", box).textContent = `${fmtLen(f.w * g.wCm)} × ${state.measured[w.id] ? "" : "~"}${fmtLen(boxHeight(w) * g.hCm)}`;
}

/** Шаг привязки: 5 мм или 0,1 дюйма. */
function snap (v, sizeCm) {
	const step = state.layout.screen.unit === "in" ? CM_PER_IN / 10 : 0.5;
	return (Math.round((v * sizeCm) / step) * step) / sizeCm;
}

let fdrag = null;

function startFreeDrag (e) {
	if (e.button !== 0) return;
	const box = e.currentTarget;
	const w = state.layout.widgets.find((x) => x.id === box.dataset.id);
	const board = $("#board");
	fdrag = { w, box, resize: e.target.classList.contains("fbox-resize"), startX: e.clientX, startY: e.clientY, orig: { ...w.free }, bw: board.clientWidth, bh: board.clientHeight, moved: false };
	box.setPointerCapture(e.pointerId);
	box.addEventListener("pointermove", onFreeMove);
	box.addEventListener("pointerup", endFreeDrag);
	box.addEventListener("pointercancel", endFreeDrag);
}

function onFreeMove (e) {
	const d = fdrag;
	if (!d) return;
	if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
	if (!d.moved) {
		d.moved = true;
		d.box.classList.add("moving");
		document.body.classList.add("is-dragging");
	}
	const g = screenGeometry();
	const dx = (e.clientX - d.startX) / d.bw;
	const dy = (e.clientY - d.startY) / d.bh;
	const f = d.w.free;
	let centered = false;
	if (d.resize) {
		f.w = clamp(snap(d.orig.w + dx, g.wCm), 0.05, 1 - d.orig.x);
	} else {
		f.x = clamp(snap(d.orig.x + dx, g.wCm), 0, 1 - f.w);
		f.y = clamp(snap(d.orig.y + dy, g.hCm), 0, Math.max(0, 1 - boxHeight(d.w)));
		// прилипание к середине экрана
		if (Math.abs(f.x + f.w / 2 - 0.5) < 0.015) {
			f.x = 0.5 - f.w / 2;
			centered = true;
		}
	}
	f.x = round(f.x, 4);
	f.y = round(f.y, 4);
	f.w = round(f.w, 4);
	$("#board").classList.toggle("show-center", centered);
	placeBox(d.box, d.w);
}

function endFreeDrag () {
	const d = fdrag;
	if (!d) return;
	fdrag = null;
	d.box.removeEventListener("pointermove", onFreeMove);
	d.box.removeEventListener("pointerup", endFreeDrag);
	d.box.removeEventListener("pointercancel", endFreeDrag);
	d.box.classList.remove("moving");
	document.body.classList.remove("is-dragging");
	$("#board").classList.remove("show-center");
	if (!d.moved) return select(d.w.id);
	select(d.w.id, { switchTab: false });
	changed();
}

/** Стрелки двигают выбранный виджет на шаг привязки, с Shift — на 1 см / 0,5″. */
function freeKey (e, w) {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		return select(w.id);
	}
	const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
	if (!dir) return;
	e.preventDefault();
	const g = screenGeometry();
	const stepCm = (state.layout.screen.unit === "in" ? CM_PER_IN / 10 : 0.5) * (e.shiftKey ? (state.layout.screen.unit === "in" ? 5 : 2) : 1);
	w.free.x = round(clamp(w.free.x + (dir[0] * stepCm) / g.wCm, 0, 1 - w.free.w), 4);
	w.free.y = round(clamp(w.free.y + (dir[1] * stepCm) / g.hCm, 0, 0.98), 4);
	state.selectedId = w.id;
	changed();
	renderWidgetTab();
	$(`.fbox[data-id="${w.id}"]`)?.focus();
}

/** Поля «от левого края / от верха / ширина» в единицах экрана. */
function freeFields (w) {
	const g = screenGeometry();
	const unit = state.layout.screen.unit;
	const toUnit = (cm) => round(unit === "in" ? cm / CM_PER_IN : cm, 1);
	const fromUnit = (v) => (unit === "in" ? v * CM_PER_IN : v);
	const u = unit === "in" ? "дюймы" : "см";
	const set = (key, sizeCm) => (v) => {
		w.free[key] = fromUnit(Number(v)) / sizeCm;
		Object.assign(w.free, { w: round(clamp(w.free.w, 0.05, 1), 4) });
		Object.assign(w.free, { x: round(clamp(w.free.x, 0, 1 - w.free.w), 4), y: round(clamp(w.free.y, 0, 0.98), 4) });
		changed();
		renderWidgetTab();
	};
	const num = (key, label, value, sizeCm) => field({ key, label: `${label}, ${u}`, type: "number", min: 0, max: toUnit(sizeCm), step: 0.1 }, toUnit(value * sizeCm), set(key, sizeCm));
	const m = state.measured[w.id];
	return [
		el("h3", { text: "Место на экране" }),
		el("div", { class: "grid3" },
			num("x", "Слева", w.free.x, g.wCm),
			num("y", "Сверху", w.free.y, g.hCm),
			num("w", "Ширина", w.free.w, g.wCm)),
		field({ key: "align", label: "Выравнивание текста", type: "select", options: [
			{ value: "left", label: "По левому краю" },
			{ value: "center", label: "По центру" },
			{ value: "right", label: "По правому краю" }
		] }, w.free.align, (v) => { w.free.align = v; changed(); }),
		el("div", { class: "row" },
			el("button", { class: "btn small", text: "По центру", onclick: () => { w.free.x = round((1 - w.free.w) / 2, 4); changed(); renderWidgetTab(); } }),
			el("button", { class: "btn small", text: "Во всю ширину", onclick: () => { Object.assign(w.free, { x: 0.04, w: 0.92 }); changed(); renderWidgetTab(); } })),
		el("p", { class: "muted small", text: m
			? `Высота по живому зеркалу: ${fmtLen(m.h * g.hCm)}. Она зависит от содержимого и шрифта.`
			: "Высота зависит от содержимого, на схеме она примерная. Точная появится после «Применить»." })
	];
}

// ---------- панель ----------

function showTab (name) {
	document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
	document.querySelectorAll(".tab-body").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
	if (name === "logs") loadLogs();
}

function select (id, { switchTab = true } = {}) {
	state.selectedId = id;
	renderBoard();
	renderWidgetTab();
	if (switchTab) {
		showTab("widget");
		if (matchMedia("(max-width: 899px)").matches) $(".panel").scrollIntoView({ behavior: "smooth", block: "start" });
	}
}

function field (f, value, onChange) {
	const id = `f_${f.key}_${Math.random().toString(36).slice(2, 7)}`;
	let input;
	switch (f.type) {
		case "checkbox":
			input = el("input", { type: "checkbox", id, checked: value, onchange: (e) => onChange(e.target.checked) });
			return el("label", { class: "field check", for: id }, input, el("span", { text: f.label }));
		case "select":
			input = el("select", { id, onchange: (e) => onChange(e.target.value) },
				f.options.map((o) => el("option", { value: o.value, selected: o.value === value, text: o.label })));
			break;
		case "json":
			input = el("textarea", { id, class: "mono", rows: 8, spellcheck: "false", oninput: (e) => {
				try {
					const v = JSON.parse(e.target.value || "{}");
					if (typeof v !== "object" || Array.isArray(v) || v === null) throw new Error();
					e.target.classList.remove("invalid");
					onChange(JSON.stringify(v, null, 2));
				} catch {
					e.target.classList.add("invalid"); // не сохраняем, пока JSON не станет правильным
				}
			} });
			input.value = value;
			break;
		case "lines":
			input = el("textarea", { id, rows: Math.min(8, Math.max(3, value.length + 1)), oninput: (e) => onChange(e.target.value.split("\n")) });
			input.value = value.join("\n");
			break;
		case "number":
			input = el("input", { id, type: "number", inputmode: "decimal", min: f.min, max: f.max, step: f.step, value, onchange: (e) => onChange(e.target.value === "" ? f.default : Number(e.target.value)) });
			break;
		case "color":
			input = el("input", { id, type: "color", value, oninput: (e) => onChange(e.target.value) });
			break;
		default:
			input = el("input", { id, type: f.type === "url" ? "url" : "text", value, oninput: (e) => onChange(e.target.value) });
	}
	return el("div", { class: "field" }, el("label", { for: id, text: f.label }), input);
}

function renderWidgetTab () {
	const box = $("#tab-widget");
	const w = selected();
	if (!w) {
		box.replaceChildren(el("div", { class: "empty-state" },
			el("p", { text: "Выберите виджет на схеме или добавьте новый." }),
			el("button", { class: "btn", text: "+ Добавить виджет", onclick: () => showTab("add") })));
		return;
	}
	const def = widgetDef(w.type);
	const inPos = state.layout.widgets.filter((x) => x.position === w.position);
	const idx = inPos.indexOf(w);

	box.replaceChildren(...[
		el("div", { class: "widget-head" },
			el("span", { class: "big-icon", text: def.icon }),
			el("div", {}, el("h2", { text: def.title }), el("span", { class: "muted", text: `модуль ${def.module}` }))),
		isFree() ? freeFields(w) : [el("div", { class: "field" },
			el("label", { for: "posSelect", text: "Расположение" }),
			el("select", { id: "posSelect", onchange: (e) => { moveWidget(w.id, e.target.value, Infinity); changed(); renderWidgetTab(); } },
				state.catalog.positions.map((p) => el("option", { value: p.id, selected: p.id === w.position, text: p.label })))),
		el("div", { class: "row" },
			el("button", { class: "btn small", disabled: idx <= 0, text: "↑ Выше", onclick: () => shiftWidget(w, -1) }),
			el("button", { class: "btn small", disabled: idx >= inPos.length - 1, text: "↓ Ниже", onclick: () => shiftWidget(w, 1) }))],
		field({ key: "header", label: "Заголовок над виджетом", type: "text" }, w.header, (v) => { w.header = v; changed(); }),
		field({ key: "enabled", label: "Показывать на зеркале", type: "checkbox" }, w.enabled, (v) => { w.enabled = v; changed(); }),
		def.note ? el("p", { class: "note", text: def.note }) : null,
		isMissing(w) ? el("div", { class: "warn-box" },
			el("div", {}, el("b", { text: "Модуль не установлен." }), " Пока его нет, на зеркале этот виджет не появится."),
			el("button", { class: "btn small primary", disabled: Boolean(state.installing), text: state.installing ? "Устанавливаю…" : `Установить ${widgetModule(w)}`, onclick: () => installModule(state.missing.get(widgetModule(w)), def.title) })) : null,
		el("h3", { text: "Настройки" }),
		def.fields.map((f) => field(f, w.options[f.key], (v) => { w.options[f.key] = v; changed({ rerender: false }); })),
		el("div", { class: "row danger-zone" },
			el("button", { class: "btn small", text: "Дублировать", onclick: () => duplicate(w) }),
			el("button", { class: "btn small danger", text: "Удалить", onclick: () => remove(w) }))
	].flat().filter((n) => n !== null && n !== undefined));
}

async function addWidget (def) {
	if (def.source && !def.installed && !(await installModule(def.source.repo, def.title))) return;
	const options = Object.fromEntries(def.fields.map((f) => [f.key, structuredClone(f.default)]));
	const w = { id: `w_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`, type: def.type, position: def.defaultPosition, header: def.defaultHeader, enabled: true, options };
	state.layout.widgets.push(w);
	if (isFree()) w.free = defaultFree(w);
	changed();
	select(w.id);
	toast(isFree() ? `«${def.title}» добавлен, перетащите его на нужное место` : `«${def.title}» → ${positionLabel(w.position)}`);
}

function duplicate (w) {
	const copy = { ...structuredClone(w), id: `w_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}` };
	if (copy.free) copy.free.y = round(clamp(copy.free.y + 0.05, 0, 0.95), 4);
	state.layout.widgets.splice(state.layout.widgets.indexOf(w) + 1, 0, copy);
	changed();
	select(copy.id);
}

function remove (w) {
	const i = state.layout.widgets.indexOf(w);
	state.layout.widgets.splice(i, 1);
	state.selectedId = null;
	changed();
	renderWidgetTab();
	const def = widgetDef(w.type);
	toastUndo(`«${w.header || def.title}» удалён`, () => {
		state.layout.widgets.splice(i, 0, w);
		changed();
		select(w.id);
	});
}

function toastUndo (msg, undo) {
	const t = $("#toast");
	t.replaceChildren(el("span", { text: msg }), el("button", { class: "link", text: "Вернуть", onclick: () => { t.className = "toast"; undo(); } }));
	t.className = "toast show";
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => (t.className = "toast"), 5000);
}

function renderAddTab () {
	const groups = new Map();
	for (const def of state.catalog.widgets) groups.set(def.group, [...(groups.get(def.group) || []), def]);
	$("#tab-add").replaceChildren(...[
		el("p", { class: "muted", text: "Нажмите на виджет — он появится на своём обычном месте, потом его можно перетащить. Виджеты с пометкой GitHub при первом добавлении скачиваются и устанавливаются." }),
		...[...groups].map(([group, defs]) => [
			el("h3", { text: group }),
			el("div", { class: "catalog" }, defs.map((def) => el("button", { class: "card", disabled: Boolean(state.installing), onclick: () => addWidget(def) },
				el("span", { class: "big-icon", text: def.icon }),
				el("span", { class: "card-title", text: def.title }),
				el("span", { class: "muted small", text: def.source ? `GitHub · ${def.source.author}` : def.custom ? "любой MMM-модуль" : positionLabel(def.defaultPosition) }),
				def.source && !def.installed ? el("span", { class: "tag", text: state.installing === def.source.repo ? "устанавливаю…" : "установить" }) : null)))
		])
	].flat().filter((n) => n !== null && n !== undefined));
}

/** Меняет поле экрана; при смене единиц или способа задания пересчитывает размеры, чтобы экран остался тем же. */
function setScreen (key, value) {
	const s = state.layout.screen;
	const g = screenGeometry();
	const k = (unit) => (unit === "in" ? CM_PER_IN : 1);
	if (key === "unit" && value !== s.unit) {
		const ratio = k(s.unit) / k(value);
		Object.assign(s, { diagonal: round(s.diagonal * ratio), width: round(s.width * ratio), height: round(s.height * ratio) });
	}
	if (key === "sizeMode" && value === "size") Object.assign(s, { width: round(g.wCm / k(s.unit)), height: round(g.hCm / k(s.unit)) });
	if (key === "sizeMode" && value === "diagonal") Object.assign(s, { diagonal: round(g.diagCm / k(s.unit)), aspect: nearestAspect(Math.max(g.wCm, g.hCm), Math.min(g.wCm, g.hCm)) });
	if (key === "orientation" && value !== s.orientation && s.sizeMode === "size") Object.assign(s, { width: s.height, height: s.width });
	s[key] = value;
	if (s.sizeMode === "size" && s.width !== s.height) s.orientation = s.width < s.height ? "portrait" : "landscape";
	applyScreen();
	changed();
	renderLookTab();
	renderWidgetTab();
}

function renderLookTab () {
	const a = state.layout.appearance;
	const s = state.layout.screen;
	const g = screenGeometry();
	const hidden = s.sizeMode === "size" ? ["diagonal", "aspect"] : ["width", "height"];
	$("#tab-look").replaceChildren(...[
		el("h3", { text: "Экран зеркала" }),
		state.catalog.screen.filter((f) => !hidden.includes(f.key)).map((f) =>
			field(["diagonal", "width", "height"].includes(f.key) ? { ...f, label: `${f.label}, ${s.unit === "in" ? "дюймы" : "см"}` } : f, s[f.key], (v) => setScreen(f.key, v))),
		el("p", { class: "note", text: `Экран ${fmtLen(g.wCm, "cm")} × ${fmtLen(g.hCm, "cm")} (${fmtLen(g.wCm, "in")} × ${fmtLen(g.hCm, "in")}), диагональ ${fmtLen(g.diagCm, "in")} = ${fmtLen(g.diagCm, "cm")}. Живой экран: ${g.px[0]} × ${g.px[1]} px.` }),
		el("h3", { text: "Оформление" }),
		el("p", { class: "muted", text: "Применяются ко всем виджетам." }),
		state.catalog.appearance.map((f) => field(f, a[f.key], (v) => { a[f.key] = v; changed({ rerender: false }); })),
		el("div", { class: "row danger-zone" },
			el("button", { class: "btn small danger", text: "Сбросить весь макет", onclick: resetLayout }))
	].flat().filter((n) => n !== null && n !== undefined));
}

async function resetLayout () {
	if (!confirm("Вернуть стандартный набор виджетов? Текущий макет будет заменён.")) return;
	const res = await api.send("POST", "/api/reset");
	Object.assign(state, { layout: res.layout, revision: res.revision, appliedRevision: res.appliedRevision, selectedId: null });
	renderAll();
}

async function loadLogs () {
	const [{ logs }, st] = await Promise.all([api.get("/api/mirror/logs"), api.get("/api/mirror")]);
	$("#logs").textContent = logs.join("\n");
	$("#logsMeta").textContent = `PID ${st.pid ?? "—"} · порт ${st.port}${st.startedAt ? ` · запущено ${new Date(st.startedAt).toLocaleTimeString("ru-RU")}` : ""}`;
	$("#logs").scrollTop = $("#logs").scrollHeight;
}

// ---------- живой экран ----------

// на этом же компьютере ходим на 127.0.0.1 — так же, как слушает зеркало
const mirrorHost = () => (["localhost", "::1", "[::1]"].includes(location.hostname) ? "127.0.0.1" : location.hostname);
const mirrorUrl = () => `${location.protocol}//${mirrorHost()}:${state.mirror?.port || 8080}/`;

// Живой экран загружен всегда: в режиме «Схема» он спрятан за пределами окна и через
// MMM-StudioBridge сообщает, где на самом деле стоят виджеты и какой они высоты.
function reloadLive () {
	// параметр в адресе, чтобы браузер не показал старую страницу ошибки
	$("#liveFrame").src = `${mirrorUrl()}?t=${Date.now()}`;
}

function onMirrorMessage (e) {
	if (e.data?.type !== "smartmirror:rects" || e.source !== $("#liveFrame").contentWindow) return;
	const before = JSON.stringify(state.measured);
	state.measured = e.data.rects || {};
	if (before === JSON.stringify(state.measured) || fdrag) return;
	if (isFree()) for (const box of document.querySelectorAll(".fbox")) {
		const w = state.layout.widgets.find((x) => x.id === box.dataset.id);
		if (w) placeBox(box, w);
	}
	if (selected() && isFree() && !document.activeElement?.closest("#tab-widget")) renderWidgetTab();
}

function fitLive () {
	const live = $("#live");
	const frame = $("#liveFrame");
	const [w, h] = screenGeometry().px;
	frame.style.width = `${w}px`;
	frame.style.height = `${h}px`;
	frame.style.transform = `scale(${live.clientWidth / w})`;
}

function setView (view) {
	state.view = view;
	document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
	$("#board").hidden = view !== "scheme";
	$("#live").classList.toggle("offscreen", view !== "live");
	$("#boardHint").textContent = view === "live"
		? "Так выглядит зеркало прямо сейчас. Изменения появятся после «Применить»."
		: isFree()
			? "Двигайте виджеты по экрану, правый край меняет ширину. Стрелки на клавиатуре сдвигают выбранный виджет."
			: "Перетаскивайте виджеты между зонами. Нажмите на виджет, чтобы настроить его.";
	$("#openMirror").href = mirrorUrl();
	$("#openMirror").hidden = view !== "live";
	requestAnimationFrame(fitLive);
}

// ---------- запуск ----------

function renderAll () {
	applyScreen();
	setView(state.view);
	renderBoard();
	renderWidgetTab();
	renderAddTab();
	renderLookTab();
	renderApply();
}

async function init () {
	const [catalog, snap] = await Promise.all([api.get("/api/catalog"), api.get("/api/layout")]);
	Object.assign(state, { catalog, layout: snap.layout, revision: snap.revision, appliedRevision: snap.appliedRevision });

	document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
	document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
	document.querySelectorAll("[data-orient]").forEach((b) => b.addEventListener("click", () => setScreen("orientation", b.dataset.orient)));
	document.querySelectorAll("[data-placement]").forEach((b) => b.addEventListener("click", () => setPlacement(b.dataset.placement)));
	addEventListener("message", onMirrorMessage);
	$("#applyBtn").addEventListener("click", applyToMirror);
	$("#logsRefresh").addEventListener("click", loadLogs);
	$("#diagBtn").addEventListener("click", async () => {
		$("#logs").textContent = "Проверяю…";
		const d = await api.get("/api/mirror/diagnose");
		$("#logs").textContent = [
			`Система: ${d.platform}`,
			`Зеркало: ${d.mirror.state}, адрес ${d.address}, порт ${d.mirror.port}, PID ${d.mirror.pid}`,
			"Проверка подключения:",
			...Object.entries(d.probes).map(([h, r]) => `  ${h} → ${r}`),
			"Кто слушает порт:", d.listening,
			d.errors.length ? `Ошибки в журнале:\n${d.errors.join("\n")}` : "Ошибок в журнале нет",
			d.excludedPorts ? `Зарезервированные Windows порты:\n${d.excludedPorts}` : ""
		].join("\n");
	});
	$("#restartBtn").addEventListener("click", restartMirror);
	$("#showLogsBtn").addEventListener("click", () => showTab("logs"));
	new ResizeObserver(fitLive).observe($("#live"));

	renderAll();
	refreshModules();
	await pollMirror(); // сначала узнаём порт зеркала, потом открываем живой экран
	reloadLive();
	if (new URLSearchParams(location.search).get("view") === "live") setView("live");
	setInterval(pollMirror, 5000);
}

init().catch((err) => toast(`Не удалось загрузить Studio: ${err.message}`, "error"));

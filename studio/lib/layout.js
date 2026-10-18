"use strict";

const crypto = require("node:crypto");
const { POSITIONS, WIDGETS, APPEARANCE_FIELDS, SCREEN_FIELDS } = require("./catalog");

const POSITION_IDS = new Set(POSITIONS.map((p) => p.id));
const MAX_WIDGETS = 40;

/** Приводит значение поля к его типу; невалидное заменяет значением по умолчанию. */
function cleanValue (field, value) {
	switch (field.type) {
		case "checkbox":
			return typeof value === "boolean" ? value : field.default;
		case "number": {
			const n = Number(value);
			if (value === "" || value === null || !Number.isFinite(n)) return field.default;
			return Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n));
		}
		case "select":
			return field.options.some((o) => o.value === value) ? value : field.default;
		case "color":
			return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : field.default;
		case "lines": {
			const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : field.default;
			return arr.map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, 100);
		}
		case "json":
			try {
				const parsed = JSON.parse(typeof value === "string" ? value : JSON.stringify(value));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify(parsed, null, 2).slice(0, 20000);
			} catch { /* ниже */ }
			return field.default;
		case "url":
			return typeof value === "string" && /^https?:\/\/\S+$/.test(value.trim()) ? value.trim() : field.default;
		default:
			return typeof value === "string" ? value.slice(0, 300) : field.default;
	}
}

function cleanFields (fields, input = {}) {
	const out = {};
	for (const f of fields) out[f.key] = cleanValue(f, input[f.key]);
	return out;
}

function newId () {
	return `w_${crypto.randomBytes(4).toString("hex")}`;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round4 = (n) => Math.round(n * 10000) / 10000;

/** Место виджета в свободной раскладке: доли экрана, левый верхний угол и ширина. */
function cleanFree (f) {
	if (!f || typeof f !== "object") return null;
	const [x, y, w] = [f.x, f.y, f.w].map(Number);
	if (![x, y, w].every(Number.isFinite)) return null;
	const width = clamp(w, 0.05, 1);
	const align = ["left", "center", "right"].includes(f.align) ? f.align : "left";
	return { x: round4(clamp(x, 0, 1 - width)), y: round4(clamp(y, 0, 0.98)), w: round4(width), align };
}

/** Выравнивание текста, как в зоне MagicMirror²: справа — по правому краю, в середине — по центру. */
function regionAlign (position) {
	if (position.endsWith("_right")) return "right";
	if (position.endsWith("_left")) return "left";
	return "center";
}

/** Место по умолчанию — там, где обычно находится зона виджета. */
function spotFree (position) {
	const spot = POSITIONS.find((p) => p.id === position)?.spot ?? { x: 0.04, y: 0.03, w: 0.4 };
	return { ...spot, align: regionAlign(position) };
}

function cleanScreen (input) {
	const s = cleanFields(SCREEN_FIELDS, input);
	// при размере «ширина × высота» ориентация следует из самих размеров
	if (s.sizeMode === "size" && s.width !== s.height) s.orientation = s.width < s.height ? "portrait" : "landscape";
	return s;
}

function cleanWidget (w) {
	const def = WIDGETS[w?.type];
	if (!def) return null;
	return {
		id: typeof w.id === "string" && /^[\w-]{1,40}$/.test(w.id) ? w.id : newId(),
		type: w.type,
		position: POSITION_IDS.has(w.position) ? w.position : def.defaultPosition,
		header: typeof w.header === "string" ? w.header.slice(0, 80) : "",
		enabled: w.enabled !== false,
		options: cleanFields(def.fields, w.options),
		free: cleanFree(w.free)
	};
}

/** Проверяет и нормализует макет, пришедший из приложения. */
function cleanLayout (input) {
	const widgets = Array.isArray(input?.widgets) ? input.widgets : [];
	const seen = new Set();
	const clean = [];
	for (const w of widgets.slice(0, MAX_WIDGETS)) {
		const c = cleanWidget(w);
		if (!c) continue;
		if (seen.has(c.id)) c.id = newId();
		seen.add(c.id);
		clean.push(c);
	}
	return {
		placement: input?.placement === "free" ? "free" : "regions",
		screen: cleanScreen(input?.screen),
		appearance: cleanFields(APPEARANCE_FIELDS, input?.appearance),
		widgets: clean
	};
}

function widget (type, position, header, options) {
	return cleanWidget({ type, position, header: header ?? WIDGETS[type].defaultHeader ?? "", options });
}

function defaultLayout () {
	return cleanLayout({
		appearance: {},
		widgets: [
			widget("clock", "top_left"),
			widget("calendar", "top_left"),
			widget("weather_now", "top_right"),
			widget("weather_forecast", "top_right"),
			widget("compliments", "lower_third"),
			widget("todo", "bottom_left"),
			widget("newsfeed", "bottom_bar")
		]
	});
}

module.exports = { cleanLayout, defaultLayout, spotFree };

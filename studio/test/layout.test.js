"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanLayout, defaultLayout } = require("../lib/layout");
const { buildConfig, renderConfigJs, renderCustomCss } = require("../lib/generate");

const env = { address: "localhost", port: 8080, ipWhitelist: ["127.0.0.1"], demoBase: null };

test("стандартный макет превращается в рабочий config.js", () => {
	const config = buildConfig(defaultLayout(), env);
	assert.equal(config.modules[0].module, "alert");
	assert.ok(config.modules.some((m) => m.module === "MMM-SimpleTodo" && m.position === "bottom_left"));
	const js = renderConfigJs(config);
	const loaded = new Function("module", `${js}; return module.exports;`)({});
	assert.deepEqual(loaded, config);
});

test("неизвестные модули, позиции и мусор отбрасываются", () => {
	const layout = cleanLayout({
		appearance: { fontSize: 999, brightColor: "red; } body { display:none", font: "Comic Sans" },
		widgets: [
			{ type: "rm -rf", position: "top_left" },
			{ type: "clock", position: "nowhere", options: { displaySeconds: "yes", displayType: "binary" } },
			{ type: "calendar", options: { url: "javascript:alert(1)", maximumEntries: "abc" } }
		]
	});
	assert.equal(layout.widgets.length, 2);
	assert.equal(layout.widgets[0].position, "top_left");
	assert.equal(layout.widgets[0].options.displaySeconds, true);
	assert.equal(layout.widgets[0].options.displayType, "digital");
	assert.match(layout.widgets[1].options.url, /^https:/);
	assert.equal(layout.widgets[1].options.maximumEntries, 6);
	assert.equal(layout.appearance.fontSize, 40);
	assert.equal(layout.appearance.brightColor, "#ffffff");
	assert.equal(layout.appearance.font, "Roboto Condensed");
	assert.doesNotMatch(renderCustomCss(layout), /display:none/);
});

test("скрытые виджеты не попадают на зеркало, порядок сохраняется", () => {
	const layout = defaultLayout();
	layout.widgets.find((w) => w.type === "newsfeed").enabled = false;
	const config = buildConfig(cleanLayout(layout), env);
	assert.ok(!config.modules.some((m) => m.module === "newsfeed"));
	const topRight = config.modules.filter((m) => m.position === "top_right").map((m) => m.config.type);
	assert.deepEqual(topRight, ["current", "forecast"]);
});

test("демо-режим подменяет внешние источники на локальные", () => {
	const config = buildConfig(defaultLayout(), { ...env, demoBase: "http://localhost:8090/demo" });
	const weather = config.modules.find((m) => m.module === "weather");
	const cal = config.modules.find((m) => m.module === "calendar");
	assert.equal(weather.config.apiBase, "http://localhost:8090/demo/open-meteo/v1");
	assert.equal(cal.config.calendars[0].url, "http://localhost:8090/demo/calendar.ics");
});

test("сторонние модули попадают в конфиг, только когда установлены", () => {
	const layout = cleanLayout({
		widgets: [
			{ type: "stocks", position: "top_left" },
			{ type: "custom", position: "top_center", options: { repo: "https://github.com/someone/MMM-Foo", config: "{\"a\": 1}" } },
			{ type: "custom", position: "top_center", options: { repo: "https://github.com/someone/MMM-Bar; rm -rf /" } }
		]
	});
	assert.equal(layout.widgets[2].options.repo, "https://github.com/KristjanESPERANTO/MMM-ISS-Live", "плохая ссылка заменена значением по умолчанию");
	const none = buildConfig(layout, env, () => false);
	assert.deepEqual(none.modules.map((m) => m.module), ["alert", "MMM-StudioBridge"]);
	const all = buildConfig(layout, env, () => true);
	assert.deepEqual(all.modules.map((m) => m.module), ["alert", "MMM-StudioBridge", "MMM-Jast", "MMM-Foo", "MMM-ISS-Live"]);
	assert.deepEqual(all.modules[3].config, { a: 1 });
});

test("размер экрана проверяется, при «ширине × высоте» ориентация берётся из размеров", () => {
	const def = cleanLayout({});
	assert.equal(def.placement, "regions");
	assert.equal(def.screen.sizeMode, "diagonal");
	assert.equal(def.screen.orientation, "portrait");
	const s = cleanLayout({ screen: { sizeMode: "size", unit: "cm", width: 60, height: 35, aspect: "7:1", diagonal: -5 } }).screen;
	assert.equal(s.orientation, "landscape");
	assert.equal(s.aspect, "16:9");
	assert.equal(s.diagonal, 3);
});

test("свободная раскладка: виджет ставится в точку экрана через custom.css", () => {
	const layout = cleanLayout({
		placement: "free",
		widgets: [
			{ id: "w_a", type: "clock", position: "bottom_right", free: { x: 0.95, y: 0.5, w: 0.3 } },
			{ id: "w_b", type: "text", position: "top_left", free: { x: "x" } }
		]
	});
	assert.deepEqual(layout.widgets[0].free, { x: 0.7, y: 0.5, w: 0.3, align: "left" }); // не вылезает за правый край
	assert.equal(layout.widgets[1].free, null);
	const config = buildConfig(layout, env);
	const clock = config.modules.find((m) => m.module === "clock");
	assert.equal(clock.position, "top_left");
	assert.equal(clock.classes, "sm-w_a");
	assert.match(config.modules.find((m) => m.module === "helloworld").classes, /bright sm-w_b$/);
	const css = renderCustomCss(layout);
	assert.match(css, /\.module\.sm-w_a \{ position: fixed !important; left: 70%; top: 50%; width: 30%;/);
	assert.match(css, /\.module\.sm-w_b \{ position: fixed !important; left: 4%; top: 3%;/); // место зоны по умолчанию
	assert.doesNotMatch(renderCustomCss({ ...layout, placement: "regions" }), /position: fixed/);
});

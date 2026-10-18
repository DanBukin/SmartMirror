"use strict";

const { WIDGETS, widgetSource } = require("./catalog");
const { spotFree } = require("./layout");

/**
 * Собирает объект конфигурации MagicMirror² из макета.
 * @param {object} layout очищенный макет (см. layout.js)
 * @param {object} env { address, port, ipWhitelist, demoBase } — demoBase задаёт адрес
 *   виртуальных источников данных (погода, календарь, новости) для работы без интернета.
 */
function buildConfig (layout, env, isInstalled = () => true) {
	const a = layout.appearance;
	// MMM-StudioBridge сообщает приложению настоящие размеры виджетов на экране
	const modules = [{ module: "alert" }, { module: "MMM-StudioBridge" }];

	for (const w of layout.widgets) {
		if (!w.enabled) continue;
		const def = WIDGETS[w.type];
		const src = widgetSource(w);
		// неустановленный сторонний модуль сломал бы зеркало — пропускаем
		if (def.custom && !src) continue;
		if (src && !isInstalled(src.module)) continue;
		// в свободной раскладке зона не важна: место задаёт custom.css по классу sm-<id>
		const entry = { module: src ? src.module : def.module, position: layout.placement === "free" ? "top_left" : w.position };
		if (w.header) entry.header = w.header;
		entry.classes = [def.classes?.(w.options), `sm-${w.id}`].filter(Boolean).join(" ");
		entry.config = def.build(w.options);
		if (env.demoBase) applyDemoSources(entry, env.demoBase);
		modules.push(entry);
	}

	return {
		address: env.address,
		port: env.port,
		basePath: "/",
		ipWhitelist: env.ipWhitelist,
		// разрешаем показывать зеркало во фрейме приложения
		httpHeaders: { contentSecurityPolicy: false, crossOriginOpenerPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false, originAgentCluster: false, frameguard: false },
		// после перезапуска сервера экран зеркала перезагрузится сам
		reloadAfterServerRestart: true,
		checkServerInterval: 3000,
		language: a.language,
		locale: a.language === "ru" ? "ru-RU" : "en-US",
		timeFormat: Number(a.timeFormat),
		units: "metric",
		modules
	};
}

function applyDemoSources (entry, base) {
	const c = entry.config;
	if (entry.module === "weather") c.apiBase = `${base}/open-meteo/v1`;
	if (entry.module === "calendar") c.calendars = c.calendars.map((cal) => ({ ...cal, url: `${base}/calendar.ics` }));
	if (entry.module === "MMM-CBRRates") c.url = `${base}/cbr.json`;
	if (entry.module === "newsfeed") c.feeds = c.feeds.map((f) => ({ ...f, url: `${base}/news.rss` }));
}

function renderConfigJs (config) {
	return `/* Этот файл создан SmartMirror Studio (${new Date().toISOString()}).
 * Ручные правки будут перезаписаны при следующем «Применить».
 * Настраивайте зеркало через приложение Studio.
 */
let config = ${JSON.stringify(config, null, "\t")};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
`;
}

const pct = (n) => `${Math.round(n * 10000) / 100}%`;

/** custom.css из настроек внешнего вида и свободной раскладки (все значения уже проверены в layout.js). */
function renderCustomCss (layout) {
	const a = layout.appearance;
	const free = layout.placement !== "free" ? "" : layout.widgets.filter((w) => w.enabled).map((w) => {
		const f = w.free || spotFree(w.position);
		// !important: при показе модуля MagicMirror² ставит ему style.position = "static"
		return `.module.sm-${w.id} { position: fixed !important; left: ${pct(f.x)}; top: ${pct(f.y)}; width: ${pct(f.w)}; margin: 0; box-sizing: border-box; text-align: ${f.align}; }`;
	}).join("\n");
	return `/* Создано SmartMirror Studio */
:root {
  --color-text: ${a.textColor};
  --color-text-bright: ${a.brightColor};
  --font-primary: "${a.font}";
  --font-size: ${a.fontSize}px;
  --gap-body-top: ${a.edgeGap}px;
  --gap-body-right: ${a.edgeGap}px;
  --gap-body-bottom: ${a.edgeGap}px;
  --gap-body-left: ${a.edgeGap}px;
}
${free ? `\n/* Свободная раскладка: место каждого виджета в долях экрана */\n${free}\n` : ""}`;
}

module.exports = { buildConfig, renderConfigJs, renderCustomCss };

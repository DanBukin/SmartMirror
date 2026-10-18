"use strict";

// Каталог виджетов. Каждый виджет описывает:
//  - поля настроек для приложения (fields) — то, что видит пользователь;
//  - build(options) — как из этих полей собрать конфиг модуля MagicMirror².
// Так приложение не зависит от формы конфигов модулей, а новые модули
// добавляются одной записью здесь.

// spot — примерное место зоны на экране (доли ширины и высоты) для свободной раскладки
const POSITIONS = [
	{ id: "top_bar", label: "Верхняя полоса", spot: { x: 0.04, y: 0.03, w: 0.92 } },
	{ id: "top_left", label: "Сверху слева", spot: { x: 0.04, y: 0.03, w: 0.4 } },
	{ id: "top_center", label: "Сверху по центру", spot: { x: 0.3, y: 0.03, w: 0.4 } },
	{ id: "top_right", label: "Сверху справа", spot: { x: 0.56, y: 0.03, w: 0.4 } },
	{ id: "upper_third", label: "Верхняя треть", spot: { x: 0.15, y: 0.28, w: 0.7 } },
	{ id: "middle_center", label: "Центр", spot: { x: 0.15, y: 0.45, w: 0.7 } },
	{ id: "lower_third", label: "Нижняя треть", spot: { x: 0.15, y: 0.62, w: 0.7 } },
	{ id: "bottom_left", label: "Снизу слева", spot: { x: 0.04, y: 0.8, w: 0.4 } },
	{ id: "bottom_center", label: "Снизу по центру", spot: { x: 0.3, y: 0.8, w: 0.4 } },
	{ id: "bottom_right", label: "Снизу справа", spot: { x: 0.56, y: 0.8, w: 0.4 } },
	{ id: "bottom_bar", label: "Нижняя полоса", spot: { x: 0.04, y: 0.9, w: 0.92 } }
];

const MOSCOW = { lat: 55.7558, lon: 37.6173 };

const WIDGETS = {
	clock: {
		module: "clock",
		title: "Часы и дата",
		icon: "🕒",
		defaultPosition: "top_left",
		fields: [
			{ key: "displayType", label: "Вид", type: "select", default: "digital", options: [
				{ value: "digital", label: "Цифровые" },
				{ value: "analog", label: "Стрелочные" },
				{ value: "both", label: "Оба" }
			] },
			{ key: "displaySeconds", label: "Показывать секунды", type: "checkbox", default: true },
			{ key: "showDate", label: "Показывать дату", type: "checkbox", default: true },
			{ key: "showWeek", label: "Номер недели", type: "checkbox", default: false }
		],
		build: (o) => ({ ...o })
	},

	weather_now: {
		module: "weather",
		title: "Погода сейчас",
		icon: "⛅",
		defaultPosition: "top_right",
		fields: [
			{ key: "lat", label: "Широта", type: "number", default: MOSCOW.lat, min: -90, max: 90, step: 0.0001 },
			{ key: "lon", label: "Долгота", type: "number", default: MOSCOW.lon, min: -180, max: 180, step: 0.0001 },
			{ key: "location", label: "Название места", type: "text", default: "Москва" }
		],
		build: (o) => ({ weatherProvider: "openmeteo", type: "current", lat: o.lat, lon: o.lon, location: o.location || false })
	},

	weather_forecast: {
		module: "weather",
		title: "Прогноз погоды",
		icon: "🌦",
		defaultPosition: "top_right",
		defaultHeader: "Прогноз",
		fields: [
			{ key: "lat", label: "Широта", type: "number", default: MOSCOW.lat, min: -90, max: 90, step: 0.0001 },
			{ key: "lon", label: "Долгота", type: "number", default: MOSCOW.lon, min: -180, max: 180, step: 0.0001 },
			{ key: "maxNumberOfDays", label: "Дней в прогнозе", type: "number", default: 5, min: 1, max: 7, step: 1 },
			{ key: "colored", label: "Цветные температуры", type: "checkbox", default: false }
		],
		build: (o) => ({ weatherProvider: "openmeteo", type: "forecast", lat: o.lat, lon: o.lon, maxNumberOfDays: o.maxNumberOfDays, colored: o.colored, fade: false })
	},

	calendar: {
		module: "calendar",
		title: "Календарь",
		icon: "📅",
		defaultPosition: "top_left",
		defaultHeader: "Календарь",
		fields: [
			{ key: "url", label: "Ссылка на календарь (iCal / .ics)", type: "url", default: "https://calendar.google.com/calendar/ical/ru.russian%23holiday%40group.v.calendar.google.com/public/basic.ics" },
			{ key: "maximumEntries", label: "Сколько событий показывать", type: "number", default: 6, min: 1, max: 30, step: 1 },
			{ key: "symbol", label: "Иконка (Font Awesome)", type: "text", default: "calendar-check" }
		],
		build: (o) => ({
			maximumEntries: o.maximumEntries,
			fade: false,
			calendars: [{ url: o.url, symbol: o.symbol || "calendar" }]
		})
	},

	todo: {
		module: "MMM-SimpleTodo",
		title: "Задачи",
		icon: "✅",
		defaultPosition: "bottom_left",
		defaultHeader: "Задачи",
		fields: [
			{ key: "items", label: "Задачи (по одной в строке, «[x] » в начале — выполнено)", type: "lines", default: ["Купить молоко", "Позвонить маме", "[x] Собрать зеркало"] },
			{ key: "hideDone", label: "Скрывать выполненные", type: "checkbox", default: false }
		],
		build: (o) => ({ items: o.items, hideDone: o.hideDone })
	},

	newsfeed: {
		module: "newsfeed",
		title: "Новости",
		icon: "📰",
		defaultPosition: "bottom_bar",
		fields: [
			{ key: "feedTitle", label: "Название источника", type: "text", default: "Lenta.ru" },
			{ key: "feedUrl", label: "RSS-лента", type: "url", default: "https://lenta.ru/rss/news" },
			{ key: "showPublishDate", label: "Показывать время публикации", type: "checkbox", default: true },
			{ key: "showDescription", label: "Показывать описание", type: "checkbox", default: false }
		],
		build: (o) => ({
			feeds: [{ title: o.feedTitle, url: o.feedUrl }],
			showSourceTitle: true,
			showPublishDate: o.showPublishDate,
			showDescription: o.showDescription
		})
	},

	compliments: {
		module: "compliments",
		title: "Фразы дня",
		icon: "💬",
		defaultPosition: "lower_third",
		fields: [
			{ key: "phrases", label: "Фразы (по одной в строке)", type: "lines", default: ["Отличного дня!", "Ты сегодня прекрасно выглядишь", "Не забудь выпить воды"] },
			{ key: "updateMinutes", label: "Менять каждые, мин", type: "number", default: 1, min: 0.1, max: 120, step: 0.1 }
		],
		build: (o) => ({ compliments: { anytime: o.phrases.length ? o.phrases : [" "] }, updateInterval: Math.round(o.updateMinutes * 60000) })
	},

	text: {
		module: "helloworld",
		title: "Текст",
		icon: "🔤",
		defaultPosition: "upper_third",
		fields: [
			{ key: "text", label: "Текст", type: "text", default: "Доброе утро!" },
			{ key: "size", label: "Размер", type: "select", default: "medium", options: [
				{ value: "small", label: "Мелкий" },
				{ value: "medium", label: "Средний" },
				{ value: "large", label: "Крупный" },
				{ value: "xlarge", label: "Очень крупный" }
			] }
		],
		build: (o) => ({ text: o.text }),
		classes: (o) => `${o.size} bright`
	}
};

// ---------- сторонние модули ----------
// source — откуда Studio ставит модуль (git clone в MagicMirror/modules + npm install).

/** "55.75, 37.62" → "37.62,55.75": пользователь вводит как в Яндекс/Google Картах, Mapbox ждёт долготу первой. */
function toLonLat (text) {
	const [lat, lon] = String(text).split(/[,;\s]+/).map(Number);
	return Number.isFinite(lat) && Number.isFinite(lon) ? `${lon},${lat}` : "";
}

/** Достаёт id видео из ссылки YouTube или возвращает строку как есть. */
function youtubeId (text) {
	const m = String(text).match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/);
	return m ? m[1] : String(text).trim();
}

Object.assign(WIDGETS, {
	cbr_rates: {
		module: "MMM-CBRRates",
		title: "Курсы валют ЦБ",
		icon: "💱",
		group: "Финансы",
		defaultPosition: "top_right",
		defaultHeader: "Курсы ЦБ",
		fields: [
			{ key: "currencies", label: "Валюты (коды через строку: USD, EUR, CNY, KZT…)", type: "lines", default: ["USD", "EUR", "CNY"] },
			{ key: "showChange", label: "Показывать изменение за день", type: "checkbox", default: true }
		],
		build: (o) => ({ currencies: o.currencies.map((c) => c.toUpperCase().slice(0, 3)), showChange: o.showChange })
	},

	stocks: {
		module: "MMM-Jast",
		title: "Акции и криптовалюты",
		icon: "📈",
		group: "Финансы",
		source: { repo: "https://github.com/jalibu/MMM-Jast", author: "jalibu" },
		note: "Котировки Yahoo Finance, ключ не нужен. Тикеры как на finance.yahoo.com: AAPL, BTC-USD, USDRUB=X.",
		defaultPosition: "top_left",
		defaultHeader: "Котировки",
		fields: [
			{ key: "symbols", label: "Бумаги: «Название = ТИКЕР» (с пробелами вокруг =), по одной в строке", type: "lines", default: ["Биткоин = BTC-USD", "Apple = AAPL", "Нефть Brent = BZ=F"] },
			{ key: "displayMode", label: "Вид", type: "select", default: "vertical", options: [
				{ value: "vertical", label: "Бегущий список" },
				{ value: "horizontal", label: "Бегущая строка" },
				{ value: "table", label: "Таблица" }
			] },
			{ key: "showChangePercent", label: "Изменение в %", type: "checkbox", default: true }
		],
		build: (o) => ({
			displayMode: o.displayMode,
			showChangePercent: o.showChangePercent,
			showColors: true,
			currencyStyle: "symbol",
			// «Название = ТИКЕР» (знак равенства с пробелами); без него строка — сам тикер
			stocks: o.symbols.map((line) => {
				const i = line.indexOf(" = ");
				return i > 0 ? { name: line.slice(0, i).trim(), symbol: line.slice(i + 3).trim() } : { name: line, symbol: line };
			})
		})
	},

	traffic: {
		module: "MMM-Traffic",
		title: "Время в пути (пробки)",
		icon: "🚗",
		group: "Дорога",
		source: { repo: "https://github.com/samlewis0602/MMM-Traffic", author: "samlewis0602" },
		note: "Считает время с учётом пробок через Mapbox. Нужен бесплатный токен: account.mapbox.com.",
		defaultPosition: "top_left",
		fields: [
			{ key: "accessToken", label: "Токен Mapbox", type: "text", default: "" },
			{ key: "origin", label: "Откуда (широта, долгота — как в Картах)", type: "text", default: "55.7558, 37.6173" },
			{ key: "destination", label: "Куда (широта, долгота)", type: "text", default: "55.7298, 37.6012" },
			{ key: "routeName", label: "Название маршрута", type: "text", default: "До работы" },
			{ key: "mode", label: "Способ", type: "select", default: "driving", options: [
				{ value: "driving", label: "На машине" },
				{ value: "cycling", label: "На велосипеде" },
				{ value: "walking", label: "Пешком" }
			] }
		],
		build: (o) => ({
			accessToken: o.accessToken,
			originCoords: toLonLat(o.origin),
			destinationCoords: toLonLat(o.destination),
			mode: o.mode,
			firstLine: "{duration} мин",
			secondLine: o.routeName,
			loadingText: "Считаю маршрут…"
		})
	},

	youtube: {
		module: "MMM-EmbedYoutube",
		title: "YouTube / трансляция",
		icon: "📺",
		group: "Видео",
		source: { repo: "https://github.com/nitpum/MMM-EmbedYoutube", author: "nitpum" },
		note: "Видео или прямой эфир с YouTube по ссылке.",
		defaultPosition: "middle_center",
		fields: [
			{ key: "video", label: "Ссылка на видео или трансляцию", type: "text", default: "https://www.youtube.com/watch?v=jfKfPfyJRdk" },
			{ key: "autoplay", label: "Запускать сразу", type: "checkbox", default: true },
			{ key: "loop", label: "По кругу", type: "checkbox", default: true },
			{ key: "width", label: "Ширина, px", type: "number", default: 560, min: 160, max: 1920, step: 10 },
			{ key: "height", label: "Высота, px", type: "number", default: 315, min: 90, max: 1080, step: 10 }
		],
		build: (o) => ({ video_id: youtubeId(o.video), autoplay: o.autoplay, loop: o.loop, controls: false, modestbranding: true, width: o.width, height: o.height })
	},

	iss_live: {
		module: "MMM-ISS-Live",
		title: "МКС онлайн",
		icon: "🛰",
		group: "Видео",
		source: { repo: "https://github.com/KristjanESPERANTO/MMM-ISS-Live", author: "KristjanESPERANTO" },
		note: "Прямая трансляция с Международной космической станции.",
		defaultPosition: "bottom_right",
		fields: [
			{ key: "width", label: "Ширина, px", type: "number", default: 480, min: 160, max: 1920, step: 10 },
			{ key: "height", label: "Высота, px", type: "number", default: 270, min: 90, max: 1080, step: 10 }
		],
		build: (o) => ({ width: `${o.width}px`, height: `${o.height}px` })
	},

	custom: {
		module: (o) => moduleNameFromRepo(o.repo),
		title: "Свой модуль по ссылке",
		icon: "🧩",
		group: "Другое",
		custom: true,
		note: "Любой модуль из списка github.com/MagicMirrorOrg/MagicMirror/wiki/3rd-party-modules. Вставьте ссылку на репозиторий и конфиг из его README.",
		defaultPosition: "top_center",
		fields: [
			{ key: "repo", label: "Ссылка на GitHub", type: "url", default: "https://github.com/KristjanESPERANTO/MMM-ISS-Live" },
			{ key: "config", label: "config модуля (JSON)", type: "json", default: "{}" }
		],
		build: (o) => JSON.parse(o.config)
	}
});

/** https://github.com/user/MMM-Foo(.git) → "MMM-Foo"; null, если ссылка не похожа на репозиторий GitHub. */
function moduleNameFromRepo (repo) {
	const m = String(repo).match(/^https:\/\/github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?\/?$/);
	return m && /^[\w-]+$/.test(m[1]) ? m[1] : null;
}

/** Модуль и репозиторий, нужные виджету (для встроенных — null). */
function widgetSource (w) {
	const def = WIDGETS[w.type];
	if (def.custom) {
		const name = moduleNameFromRepo(w.options.repo);
		return name ? { module: name, repo: w.options.repo.replace(/\/$/, "") } : null;
	}
	return def.source ? { module: def.module, repo: def.source.repo } : null;
}

// Внешний вид всего зеркала.
const APPEARANCE_FIELDS = [
	{ key: "language", label: "Язык модулей", type: "select", default: "ru", options: [
		{ value: "ru", label: "Русский" },
		{ value: "en", label: "English" }
	] },
	{ key: "timeFormat", label: "Формат времени", type: "select", default: "24", options: [
		{ value: "24", label: "24 часа" },
		{ value: "12", label: "12 часов" }
	] },
	{ key: "fontSize", label: "Размер шрифта, px", type: "number", default: 20, min: 12, max: 40, step: 1 },
	{ key: "edgeGap", label: "Отступ от края, px", type: "number", default: 60, min: 0, max: 200, step: 5 },
	{ key: "brightColor", label: "Цвет акцента", type: "color", default: "#ffffff" },
	{ key: "textColor", label: "Цвет текста", type: "color", default: "#999999" },
	{ key: "font", label: "Шрифт", type: "select", default: "Roboto Condensed", options: [
		{ value: "Roboto Condensed", label: "Roboto Condensed" },
		{ value: "Roboto", label: "Roboto" }
	] }
];

// Экран зеркала: физический размер задаётся диагональю и соотношением сторон
// или шириной и высотой, в сантиметрах или дюймах.
const SCREEN_FIELDS = [
	{ key: "sizeMode", label: "Как задать размер", type: "select", default: "diagonal", options: [
		{ value: "diagonal", label: "Диагональ и соотношение сторон" },
		{ value: "size", label: "Ширина и высота" }
	] },
	{ key: "unit", label: "Единицы", type: "select", default: "in", options: [
		{ value: "in", label: "Дюймы" },
		{ value: "cm", label: "Сантиметры" }
	] },
	{ key: "diagonal", label: "Диагональ", type: "number", default: 24, min: 3, max: 400, step: 0.1 },
	{ key: "aspect", label: "Соотношение сторон", type: "select", default: "16:9", options: [
		{ value: "16:9", label: "16:9 (обычный монитор, ТВ)" },
		{ value: "16:10", label: "16:10" },
		{ value: "21:9", label: "21:9 (широкий)" },
		{ value: "3:2", label: "3:2" },
		{ value: "4:3", label: "4:3" },
		{ value: "5:4", label: "5:4" }
	] },
	{ key: "width", label: "Ширина", type: "number", default: 11.8, min: 1, max: 400, step: 0.1 },
	{ key: "height", label: "Высота", type: "number", default: 20.9, min: 1, max: 400, step: 0.1 },
	{ key: "orientation", label: "Ориентация", type: "select", default: "portrait", options: [
		{ value: "portrait", label: "Вертикально" },
		{ value: "landscape", label: "Горизонтально" }
	] }
];

// Примерная высота виджета в пикселях зеркала (ширина экрана 1080) для схемы
// свободной раскладки, пока зеркало не сообщило настоящий размер.
const BOX_HEIGHT = { clock: 170, weather_now: 140, weather_forecast: 280, calendar: 320, todo: 200, newsfeed: 120, compliments: 90, text: 80, cbr_rates: 200, stocks: 160, traffic: 90, youtube: 340, iss_live: 300, custom: 150 };

/** Каталог без функций — то, что уходит в приложение. */
function publicCatalog (isInstalled = () => true) {
	return {
		positions: POSITIONS,
		appearance: APPEARANCE_FIELDS,
		screen: SCREEN_FIELDS,
		widgets: Object.entries(WIDGETS).map(([type, w]) => ({
			type,
			title: w.title,
			icon: w.icon,
			module: typeof w.module === "string" ? w.module : null,
			group: w.group || "Основные",
			note: w.note || "",
			source: w.source || null,
			custom: Boolean(w.custom),
			installed: w.source ? isInstalled(w.module) : true,
			defaultPosition: w.defaultPosition,
			defaultHeader: w.defaultHeader || "",
			boxHeight: BOX_HEIGHT[type] || 150,
			fields: w.fields
		}))
	};
}

module.exports = { POSITIONS, WIDGETS, APPEARANCE_FIELDS, SCREEN_FIELDS, publicCatalog, widgetSource, moduleNameFromRepo };

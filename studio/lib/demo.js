"use strict";

// Виртуальные источники данных для работы без интернета и без Raspberry Pi:
// имитация Open-Meteo, календаря (.ics) и RSS-ленты. Включаются переменной DEMO=1.

const DAY = 24 * 3600;

function startOfDay (d = new Date()) {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return Math.floor(x.getTime() / 1000);
}

function openMeteo (query) {
	const days = Math.min(Number(query.get("forecast_days")) || 1, 8);
	const now = Math.floor(Date.now() / 1000);
	const t0 = startOfDay();
	const codes = [2, 3, 61, 1, 0, 3, 80, 2];
	const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], weathercode: [], sunrise: [], sunset: [], windspeed_10m_max: [], winddirection_10m_dominant: [], precipitation_sum: [], rain_sum: [], snowfall_sum: [], precipitation_hours: [], uv_index_max: [] };
	for (let i = 0; i < days; i++) {
		const day = t0 + i * DAY;
		daily.time.push(day);
		daily.temperature_2m_max.push(9 - (i % 3) + (i === 2 ? 2 : 0));
		daily.temperature_2m_min.push(2 + (i % 2));
		daily.weathercode.push(codes[i % codes.length]);
		daily.sunrise.push(day + 7 * 3600 + 25 * 60);
		daily.sunset.push(day + 17 * 3600 + 40 * 60);
		daily.windspeed_10m_max.push(4 + i % 3);
		daily.winddirection_10m_dominant.push(200 + i * 10);
		daily.precipitation_sum.push(codes[i % codes.length] >= 61 ? 3.2 : 0);
		daily.rain_sum.push(codes[i % codes.length] >= 61 ? 3.2 : 0);
		daily.snowfall_sum.push(0);
		daily.precipitation_hours.push(codes[i % codes.length] >= 61 ? 5 : 0);
		daily.uv_index_max.push(1.5);
	}
	const hourly = { time: [], temperature_2m: [], relativehumidity_2m: [], apparent_temperature: [], rain: [], snowfall: [], precipitation: [], precipitation_probability: [], uv_index: [], weathercode: [], windspeed_10m: [], winddirection_10m: [] };
	for (let h = 0; h < days * 24; h++) {
		const hourOfDay = h % 24;
		hourly.time.push(t0 + h * 3600);
		hourly.temperature_2m.push(Math.round((5 + 3 * Math.sin((hourOfDay - 9) / 24 * 2 * Math.PI)) * 10) / 10);
		hourly.relativehumidity_2m.push(78);
		hourly.apparent_temperature.push(3);
		hourly.rain.push(0);
		hourly.snowfall.push(0);
		hourly.precipitation.push(0);
		hourly.precipitation_probability.push(20);
		hourly.uv_index.push(1);
		hourly.weathercode.push(daily.weathercode[Math.floor(h / 24)]);
		hourly.windspeed_10m.push(4);
		hourly.winddirection_10m.push(210);
	}
	const idx = Math.max(0, Math.floor((now - t0) / 3600));
	return {
		latitude: Number(query.get("latitude")),
		longitude: Number(query.get("longitude")),
		current_weather: { time: now, temperature: hourly.temperature_2m[idx] ?? 6, windspeed: 4.2, winddirection: 210, weathercode: 2, is_day: 1 },
		hourly,
		daily
	};
}

function icsDate (d) {
	return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function calendar () {
	const events = [
		{ in: 0, h: 19, title: "Ужин с друзьями" },
		{ in: 1, h: 10, title: "Стоматолог" },
		{ in: 2, h: 18, title: "Тренировка" },
		{ in: 4, h: 12, title: "День рождения Ани" },
		{ in: 6, h: 9, title: "Планёрка по проекту зеркала" },
		{ in: 9, h: 15, title: "Поездка на дачу" }
	];
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SmartMirror Studio//Demo//RU"];
	for (const [i, e] of events.entries()) {
		const start = new Date();
		start.setDate(start.getDate() + e.in);
		start.setHours(e.h, 0, 0, 0);
		if (start < new Date()) start.setHours(23, 0, 0, 0);
		const end = new Date(start.getTime() + 3600 * 1000);
		lines.push("BEGIN:VEVENT", `UID:demo-${i}@smartmirror`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${e.title}`, "END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return `${lines.join("\r\n")}\r\n`;
}

function news () {
	const items = [
		"Демо-лента: в Москве ожидается переменная облачность",
		"Демо-лента: умное зеркало научилось показывать задачи",
		"Демо-лента: Raspberry Pi 4 по-прежнему популярен у самодельщиков",
		"Демо-лента: MagicMirror² вышел в новой версии"
	];
	const now = Date.now();
	const body = items.map((t, i) => `<item><title>${t}</title><link>https://example.com/${i}</link><guid>demo-${i}</guid><pubDate>${new Date(now - (i + 1) * 47 * 60000).toUTCString()}</pubDate><description>Новость для проверки зеркала без интернета.</description></item>`).join("");
	return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Демо</title><link>https://example.com</link><description>Демо-лента</description>${body}</channel></rss>`;
}

function cbr () {
	const v = (code, name, nominal, value, prev) => ({ CharCode: code, Nominal: nominal, Name: name, Value: value, Previous: prev });
	const today = new Date();
	today.setHours(11, 30, 0, 0);
	return {
		Date: today.toISOString(),
		PreviousDate: new Date(today - 86400000).toISOString(),
		Valute: {
			USD: v("USD", "Доллар США", 1, 81.4512, 81.2034),
			EUR: v("EUR", "Евро", 1, 94.8821, 95.1307),
			CNY: v("CNY", "Юань", 1, 11.3405, 11.3401),
			GBP: v("GBP", "Фунт стерлингов", 1, 108.6402, 108.1199),
			KZT: v("KZT", "Тенге", 100, 15.3021, 15.2876),
			TRY: v("TRY", "Турецкая лира", 10, 19.7012, 19.7533)
		}
	};
}

/** Обрабатывает /demo/*; возвращает true, если запрос обработан. */
function handleDemo (url, res) {
	if (url.pathname === "/demo/open-meteo/v1/forecast") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(openMeteo(url.searchParams)));
		return true;
	}
	if (url.pathname === "/demo/calendar.ics") {
		res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" });
		res.end(calendar());
		return true;
	}
	if (url.pathname === "/demo/cbr.json") {
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(cbr()));
		return true;
	}
	if (url.pathname === "/demo/news.rss") {
		res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
		res.end(news());
		return true;
	}
	return false;
}

module.exports = { handleDemo };

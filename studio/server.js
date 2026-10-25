"use strict";

// SmartMirror Studio — сервер-агент зеркала.
// Хранит макет виджетов, отдаёт веб-приложение, генерирует config.js
// для MagicMirror² и перезапускает зеркало после «Применить».
// Зависимостей нет: только Node.js ≥ 22.

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { publicCatalog } = require("./lib/catalog");
const { cleanLayout, defaultLayout } = require("./lib/layout");
const { buildConfig, renderConfigJs, renderCustomCss } = require("./lib/generate");
const { Mirror } = require("./lib/mirror");
const { handleDemo } = require("./lib/demo");
const { Installer } = require("./lib/installer");
const { widgetSource } = require("./lib/catalog");
const { createNetwork } = require("./lib/network");
const { Onboarding } = require("./lib/onboarding");
const { qrSvg } = require("./lib/qr");

const STUDIO_PORT = Number(process.env.STUDIO_PORT || 8090);
const STUDIO_HOST = process.env.STUDIO_HOST || "0.0.0.0";
const MM_DIR = path.resolve(process.env.MM_DIR || path.join(__dirname, "..", "..", "MagicMirror"));
const MM_PORT = Number(process.env.MM_PORT || 8080);
// Явный IPv4-адрес: «localhost» на Windows может стать ::1, а там соединения бывают заблокированы.
// Для доступа с телефона в локальной сети задайте MM_ADDRESS=0.0.0.0.
const MM_ADDRESS = process.env.MM_ADDRESS || "127.0.0.1";
const MM_START_CMD = (process.env.MM_START_CMD || "node serveronly").split(" ");
const DEMO = process.env.DEMO === "1" || process.argv.includes("--demo");
const DATA_FILE = path.join(process.env.STUDIO_DATA || path.join(__dirname, "data"), "layout.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MODULES_SRC = path.join(__dirname, "..", "modules");
// Первый запуск на Raspberry Pi: NET_BACKEND=nmcli (настоящий Wi‑Fi) или mock (виртуальный).
const NET_BACKEND = process.env.NET_BACKEND || process.argv.find((a) => a.startsWith("--net="))?.slice(6) || "";
// Привязка телефона: менять зеркало из сети можно только с привязанного устройства.
const PAIRING = (process.env.PAIRING ?? (NET_BACKEND ? "1" : "0")) === "1";
// Порт 80 для «страницы входа» точки доступа: телефон сам открывает настройку.
const CAPTIVE_PORT = Number(process.env.CAPTIVE_PORT || 0) || null;

const installer = new Installer(MM_DIR);
const isInstalled = (name) => installer.isInstalled(name);
const mirror = new Mirror({ dir: MM_DIR, port: MM_PORT, address: MM_ADDRESS, command: MM_START_CMD, env: {} });

const network = createNetwork(NET_BACKEND, { dataDir: path.dirname(DATA_FILE) });
const onboarding = network && new Onboarding({
	network,
	file: path.join(path.dirname(DATA_FILE), "device.json"),
	studioPort: STUDIO_PORT,
	captivePort: CAPTIVE_PORT,
	bootWait: Number(process.env.BOOT_WAIT_MS ?? (NET_BACKEND === "mock" ? 1500 : 25000)),
	offlineGrace: Number(process.env.OFFLINE_GRACE_MS ?? 60000),
	tick: Number(process.env.ONBOARDING_TICK_MS ?? 5000),
	// после настройки Wi‑Fi модули (погода, новости) должны сразу сходить за данными
	onOnline: () => { if (mirror.child) mirror.restart().catch(() => {}); }
});

// ---------- хранилище макета ----------

let store = loadStore();
let applying = false;

function loadStore () {
	try {
		const s = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
		return { revision: s.revision || 1, appliedRevision: s.appliedRevision || 0, layout: cleanLayout(s.layout), appliedLayout: s.appliedLayout ? cleanLayout(s.appliedLayout) : null };
	} catch {
		return { revision: 1, appliedRevision: 0, layout: defaultLayout(), appliedLayout: null };
	}
}

async function saveStore () {
	await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
	const tmp = `${DATA_FILE}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
	await fsp.rename(tmp, DATA_FILE);
}

function snapshot () {
	return { revision: store.revision, appliedRevision: store.appliedRevision, layout: store.layout };
}

// ---------- применение к зеркалу ----------

/** Подключает собственные модули (например, MMM-SimpleTodo) в папку modules зеркала. */
function linkOwnModules () {
	for (const name of fs.readdirSync(MODULES_SRC)) {
		const target = path.join(MM_DIR, "modules", name);
		if (!fs.existsSync(target)) fs.symlinkSync(path.join(MODULES_SRC, name), target, "junction"); // junction работает в Windows без прав администратора
	}
}

async function writeMirrorConfig (layout) {
	const config = buildConfig(layout, {
		address: MM_ADDRESS,
		port: mirror.port,
		ipWhitelist: (process.env.MM_IP_WHITELIST ?? "127.0.0.1,::ffff:127.0.0.1,::1").split(",").filter(Boolean),
		demoBase: DEMO ? `http://127.0.0.1:${STUDIO_PORT}/demo` : null
	}, isInstalled);
	const cfgPath = path.join(MM_DIR, "config", "config.js");
	if (fs.existsSync(cfgPath)) await fsp.copyFile(cfgPath, `${cfgPath}.bak`);
	await fsp.writeFile(cfgPath, renderConfigJs(config));
	await fsp.writeFile(path.join(MM_DIR, "config", "custom.css"), renderCustomCss(layout));
}

async function apply () {
	if (applying) return { ok: false, error: "Зеркало уже перезапускается" };
	applying = true;
	try {
		const { revision, layout } = store;
		await writeMirrorConfig(layout);
		const ok = await mirror.restart();
		if (!ok) return { ok: false, error: mirror.lastError || "Зеркало не запустилось", logs: mirror.logs.slice(-30) };
		store.appliedRevision = revision;
		store.appliedLayout = layout;
		await saveStore();
		return { ok: true, ...snapshot() };
	} finally {
		applying = false;
	}
}

/**
 * Проверяет, что порт можно и открыть, и реально до него достучаться.
 * На Windows часть портов (часто 8080) зарезервирована Hyper-V / WSL / Docker,
 * а антивирусы перехватывают HTTP-порты — тогда подключение падает с EACCES.
 */
function canServe (port, host) {
	return new Promise((resolve) => {
		const srv = http.createServer((req, res) => res.end("ok"));
		const done = (ok) => srv.close(() => resolve(ok));
		srv.once("error", () => resolve(false));
		srv.listen(port, host, async () => {
			const hosts = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
			for (const h of hosts) {
				const ok = await new Promise((r) => {
					const req = http.get({ host: h, port, path: "/", timeout: 1500 }, (res) => {
						res.resume();
						r(res.statusCode === 200);
					});
					req.on("error", () => r(false));
					req.on("timeout", () => req.destroy());
				});
				if (ok) return done(true);
			}
			done(false);
		});
	});
}

async function pickMirrorPort () {
	const candidates = [MM_PORT, ...Array.from({ length: 20 }, (_, i) => MM_PORT + i + 1), 18080, 28080, 38080];
	for (const port of candidates) {
		if (await canServe(port, MM_ADDRESS)) {
			if (port !== MM_PORT) console.log(`Порт ${MM_PORT} недоступен (занят, зарезервирован Windows или перехвачен антивирусом) — зеркало будет на порту ${port}`);
			return port;
		}
	}
	return MM_PORT;
}

/** Сводка для поиска причины, почему зеркало недоступно. */
async function diagnose () {
	const port = mirror.port;
	const probe = async (host) => new Promise((resolve) => {
		const req = http.get({ host, port, path: "/startup", timeout: 2000 }, (r) => {
			r.resume();
			resolve(`HTTP ${r.statusCode}`);
		});
		req.on("error", (e) => resolve(`${e.code || ""} ${e.message}`.trim()));
		req.on("timeout", () => req.destroy(new Error("timeout")));
	});
	const run = (cmd) => new Promise((resolve) => {
		require("node:child_process").exec(cmd, { timeout: 8000, windowsHide: true }, (err, out, errOut) => resolve((out || errOut || err?.message || "").trim()));
	});
	const win = process.platform === "win32";
	const listening = (await run(win ? "netstat -ano -p tcp & netstat -ano -p tcpv6" : "ss -ltnp"))
		.split(/\r?\n/).filter((l) => l.includes(`:${port} `) || l.includes(`]:${port} `)).join("\n");
	return {
		platform: `${process.platform} ${process.arch}, node ${process.version}`,
		mirror: mirror.status(),
		address: MM_ADDRESS,
		probes: { "127.0.0.1": await probe("127.0.0.1"), "::1": await probe("::1"), localhost: await probe("localhost") },
		listening: listening || "(никто не слушает этот порт)",
		excludedPorts: win ? await run("netsh int ipv4 show excludedportrange protocol=tcp") : "",
		errors: mirror.logs.filter((l) => /\[ERROR\]|fail|eacces|eaddr/i.test(l)).slice(-20)
	};
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

function sendJson (res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

function readBody (req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > 256 * 1024) {
				reject(new Error("Слишком большой запрос"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(new Error("Некорректный JSON"));
			}
		});
		req.on("error", reject);
	});
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress);

function cookies (req) {
	return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)]));
}

/** Можно ли этому запросу менять зеркало: с самого устройства — да, из сети — только с привязанного телефона. */
const authorized = (req) => !PAIRING || isLocal(req) || Boolean(onboarding?.isPaired(cookies(req).sm_token));

function sendSvg (res, svg) {
	res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
	res.end(svg);
}

function redirect (res, location, headers = {}) {
	res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
	res.end();
}

const PAGES = { "/": "index.html", "/screen": "screen.html", "/setup": "setup.html" };

async function serveStatic (url, res, page) {
	const rel = page || PAGES[url.pathname] || url.pathname.slice(1);
	const file = path.join(PUBLIC_DIR, path.normalize(rel));
	if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: "not found" });
	try {
		const data = await fsp.readFile(file);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
		res.end(data);
	} catch {
		sendJson(res, 404, { error: "not found" });
	}
}

/** Первый запуск: экран зеркала, настройка Wi‑Fi с телефона, привязка. null — запрос не про это. */
async function routeOnboarding (req, res, url) {
	const key = `${req.method} ${url.pathname}`;
	const local = isLocal(req);
	const inSetup = onboarding.phase !== "online";
	if (url.pathname.startsWith("/api/device") && !authorized(req)) return sendJson(res, 401, { error: "Телефон не привязан к зеркалу", needPairing: true });

	switch (key) {
		// экран зеркала: здесь пароль точки доступа и код привязки, поэтому только с самого устройства
		case "GET /api/onboarding/screen":
			if (!local) return sendJson(res, 403, { error: "Только для экрана зеркала" });
			return sendJson(res, 200, { ...onboarding.screenState(), mirrorPort: mirror.port, mirrorState: mirror.state });
		case "GET /api/onboarding/qr/wifi.svg":
		case "GET /api/onboarding/qr/setup.svg":
		case "GET /api/onboarding/qr/studio.svg": {
			if (!local) return sendJson(res, 403, { error: "Только для экрана зеркала" });
			const kind = url.pathname.split("/").pop().replace(".svg", "");
			const text = kind === "wifi" ? onboarding.wifiQrText() : kind === "setup" ? onboarding.setupUrl() : onboarding.studioUrl(true);
			return sendSvg(res, qrSvg(text));
		}
		// страница настройки Wi‑Fi: открыта, пока зеркало в режиме настройки (в его сеть
		// попадают только те, кто видел пароль на экране)
		case "GET /api/onboarding/setup":
			// в сети страница настройки узнаёт только, что всё получилось
			if (!inSetup && !authorized(req)) return sendJson(res, 200, { phase: onboarding.phase, ssid: onboarding.setupState().ssid });
			onboarding.touchSetup();
			return sendJson(res, 200, onboarding.setupState());
		case "POST /api/onboarding/rescan":
			if (!inSetup) return sendJson(res, 409, { error: "Зеркало уже подключено к Wi‑Fi" });
			onboarding.touchSetup();
			return sendJson(res, 200, { networks: await onboarding.rescan() });
		case "POST /api/onboarding/connect": {
			const body = await readBody(req);
			onboarding.touchSetup();
			const r = onboarding.connect(body.ssid, body.password, { hidden: Boolean(body.hidden) });
			return sendJson(res, r.ok ? 202 : 400, r.ok ? onboarding.setupState() : r);
		}
		case "GET /pair": {
			const token = onboarding.pair(url.searchParams.get("code"), req.headers["user-agent"]);
			if (!token) return redirect(res, "/?pair=expired");
			return redirect(res, "/", { "Set-Cookie": `sm_token=${token}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax` });
		}
		// устройство: для привязанного телефона
		case "GET /api/device":
			return sendJson(res, 200, { pairing: PAIRING, phase: onboarding.phase, network: onboarding.screenState().network, devices: onboarding.devices() });
		case "POST /api/device/show-qr":
			onboarding.showQr();
			return sendJson(res, 200, { ok: true });
		case "POST /api/device/change-network": {
			const r = onboarding.changeNetwork();
			return sendJson(res, r.ok ? 200 : 409, r);
		}
		case "POST /api/device/unpair": {
			const body = await readBody(req);
			return sendJson(res, onboarding.unpair(body.id) ? 200 : 404, { devices: onboarding.devices() });
		}
		// «окружение» виртуального Wi‑Fi для проверок: выключить/включить роутер
		case "POST /api/dev/network": {
			if (NET_BACKEND !== "mock" || !local) return sendJson(res, 404, { error: "not found" });
			const body = await readBody(req);
			return sendJson(res, network.setRouter(body.ssid, body.up) ? 200 : 404, await network.status());
		}
	}
	// пока зеркало настраивается, всё из его сети ведёт на страницу настройки
	if (inSetup && !local && req.method === "GET" && url.pathname === "/") return redirect(res, "/setup");
	return null;
}

async function route (req, res) {
	const url = new URL(req.url, "http://localhost");
	const key = `${req.method} ${url.pathname}`;

	if (url.pathname.startsWith("/demo/") && DEMO && handleDemo(url, res)) return;
	if (onboarding && (await routeOnboarding(req, res, url)) !== null) return;
	if (!authorized(req)) {
		// без привязки: страница «отсканируйте QR на зеркале» вместо Studio
		if (url.pathname === "/" || url.pathname === "/index.html") return serveStatic(url, res, "pair.html");
		if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "Телефон не привязан к зеркалу — отсканируйте QR-код на экране", needPairing: true });
	}

	switch (key) {
		case "GET /api/catalog":
			return sendJson(res, 200, publicCatalog(isInstalled));
		case "GET /api/modules": {
			// какие сторонние модули из макета ещё не установлены
			const missing = store.layout.widgets.map(widgetSource).filter((s) => s && !isInstalled(s.module));
			return sendJson(res, 200, { installing: installer.busy, missing: [...new Map(missing.map((m) => [m.module, m])).values()] });
		}
		case "POST /api/modules/install": {
			const body = await readBody(req);
			const result = await installer.install(body.repo);
			return sendJson(res, result.ok ? 200 : 500, result);
		}
		case "GET /api/layout":
			return sendJson(res, 200, snapshot());
		case "PUT /api/layout": {
			const body = await readBody(req);
			if (body.baseRevision !== undefined && body.baseRevision !== store.revision) {
				return sendJson(res, 409, { error: "Макет изменили с другого устройства", ...snapshot() });
			}
			store.layout = cleanLayout(body.layout);
			store.revision += 1;
			await saveStore();
			return sendJson(res, 200, snapshot());
		}
		case "POST /api/apply": {
			const result = await apply();
			return sendJson(res, result.ok ? 200 : 500, result);
		}
		case "POST /api/reset": {
			store.layout = defaultLayout();
			store.revision += 1;
			await saveStore();
			return sendJson(res, 200, snapshot());
		}
		case "GET /api/mirror":
			await mirror.refresh();
			return sendJson(res, 200, { ...mirror.status(), demo: DEMO, applying });
		case "POST /api/mirror/restart": {
			if (applying) return sendJson(res, 409, { error: "Зеркало уже перезапускается" });
			applying = true;
			try {
				await writeMirrorConfig(store.appliedLayout || store.layout);
				const ok = await mirror.restart();
				return sendJson(res, ok ? 200 : 500, { ok, ...mirror.status() });
			} finally {
				applying = false;
			}
		}
		case "GET /api/mirror/diagnose":
			return sendJson(res, 200, await diagnose());
		case "GET /api/mirror/logs":
			return sendJson(res, 200, { logs: mirror.logs.slice(-200) });
		default:
			if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(url, res);
			return sendJson(res, 404, { error: "not found" });
	}
}

const server = http.createServer((req, res) => {
	route(req, res).catch((err) => sendJson(res, 400, { error: err.message }));
});

/**
 * Порт 80 в режиме настройки: DNS точки доступа отвечает адресом зеркала на любое имя
 * (pi/install.sh), а этот сервер отправляет все чужие адреса на страницу настройки —
 * так iPhone и Android сами показывают её после подключения к сети.
 */
const captive = CAPTIVE_PORT && http.createServer((req, res) => {
	const host = String(req.headers.host || "").replace(/:\d+$/, "");
	if (onboarding && onboarding.phase !== "online" && host !== network.apIp) return redirect(res, onboarding.setupUrl());
	route(req, res).catch((err) => sendJson(res, 400, { error: err.message }));
});

async function main () {
	if (!fs.existsSync(path.join(MM_DIR, "serveronly"))) {
		console.error(`MagicMirror² не найден в ${MM_DIR}. Укажите путь в MM_DIR.`);
		process.exit(1);
	}
	linkOwnModules();
	mirror.port = await pickMirrorPort();
	server.listen(STUDIO_PORT, STUDIO_HOST, () => {
		console.log(`SmartMirror Studio: http://localhost:${STUDIO_PORT}  (зеркало: http://localhost:${mirror.port}${DEMO ? ", демо-данные" : ""})`);
		if (onboarding) console.log(`Экран зеркала: http://localhost:${STUDIO_PORT}/screen  (Wi‑Fi: ${NET_BACKEND}${PAIRING ? ", привязка телефона" : ""})`);
	});
	if (captive) captive.listen(CAPTIVE_PORT, STUDIO_HOST).on("error", (e) => console.error(`Порт ${CAPTIVE_PORT} для страницы настройки недоступен: ${e.message}`));
	onboarding?.start().catch((e) => console.error(`Первый запуск: ${e.message}`));
	// при старте зеркало получает последний применённый макет
	if (!store.appliedLayout) {
		store.appliedLayout = store.layout;
		store.appliedRevision = store.revision;
		await saveStore();
	}
	await writeMirrorConfig(store.appliedLayout);
	await mirror.start();
	console.log(`MagicMirror²: ${mirror.state}`);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, async () => {
		onboarding?.stop();
		await mirror.stop();
		process.exit(0);
	});
}

main();

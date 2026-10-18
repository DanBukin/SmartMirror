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

const STUDIO_PORT = Number(process.env.STUDIO_PORT || 8090);
const STUDIO_HOST = process.env.STUDIO_HOST || "0.0.0.0";
const MM_DIR = path.resolve(process.env.MM_DIR || path.join(__dirname, "..", "..", "MagicMirror"));
const MM_PORT = Number(process.env.MM_PORT || 8080);
// Явный IPv4-адрес: «localhost» на Windows может стать ::1, а там соединения бывают заблокированы.
// Для доступа с телефона в локальной сети задайте MM_ADDRESS=0.0.0.0.
const MM_ADDRESS = process.env.MM_ADDRESS || "127.0.0.1";
const MM_START_CMD = (process.env.MM_START_CMD || "node serveronly").split(" ");
const DEMO = process.env.DEMO === "1" || process.argv.includes("--demo");
const DATA_FILE = path.join(__dirname, "data", "layout.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MODULES_SRC = path.join(__dirname, "..", "modules");

const installer = new Installer(MM_DIR);
const isInstalled = (name) => installer.isInstalled(name);
const mirror = new Mirror({ dir: MM_DIR, port: MM_PORT, address: MM_ADDRESS, command: MM_START_CMD, env: {} });

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
		ipWhitelist: (process.env.MM_IP_WHITELIST || "127.0.0.1,::ffff:127.0.0.1,::1").split(",").filter(Boolean),
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

async function serveStatic (url, res) {
	const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
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

async function route (req, res) {
	const url = new URL(req.url, "http://localhost");
	const key = `${req.method} ${url.pathname}`;

	if (url.pathname.startsWith("/demo/") && DEMO && handleDemo(url, res)) return;

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

async function main () {
	if (!fs.existsSync(path.join(MM_DIR, "serveronly"))) {
		console.error(`MagicMirror² не найден в ${MM_DIR}. Укажите путь в MM_DIR.`);
		process.exit(1);
	}
	linkOwnModules();
	mirror.port = await pickMirrorPort();
	server.listen(STUDIO_PORT, STUDIO_HOST, () => {
		console.log(`SmartMirror Studio: http://localhost:${STUDIO_PORT}  (зеркало: http://localhost:${mirror.port}${DEMO ? ", демо-данные" : ""})`);
	});
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
		await mirror.stop();
		process.exit(0);
	});
}

main();

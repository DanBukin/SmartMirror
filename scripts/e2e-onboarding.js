// Сквозная проверка первого запуска на Raspberry Pi — без Raspberry Pi.
// Запускает Studio с виртуальным Wi‑Fi (NET_BACKEND=mock) и проходит путь пользователя:
// экран с QR → телефон в сети зеркала → неверный пароль → верный пароль →
// MagicMirror² с QR для Studio → привязка телефона → виджет с телефона → обрыв Wi‑Fi.
// QR-коды распознаются с экрана (jsQR), а не берутся из API.
//
// Запуск: NODE_PATH=$(npm root -g) node scripts/e2e-onboarding.js [папка для снимков]
// Нужны playwright и jsqr (npm i -g jsqr). Порты 8090 и 8080 должны быть свободны.
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "shots", "pi"));
const STUDIO = "http://localhost:8090";
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const step = (msg) => console.log(`• ${msg}`);

function startStudio () {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "sm-e2e-onb-"));
	const child = spawn(process.execPath, ["server.js", "--demo"], {
		cwd: path.join(__dirname, "..", "studio"),
		env: {
			...process.env,
			NET_BACKEND: "mock",
			STUDIO_DATA: data,
			MOCK_WIFI_DELAY: "800",
			OFFLINE_GRACE_MS: "4000",
			ONBOARDING_TICK_MS: "1000",
			// телефон открывает живой экран по адресу компьютера, как на Pi
			MM_ADDRESS: "0.0.0.0",
			MM_IP_WHITELIST: ""
		},
		stdio: ["ignore", "pipe", "pipe"]
	});
	child.stdout.on("data", (d) => process.env.DEBUG && process.stdout.write(d));
	child.stderr.on("data", (d) => process.stderr.write(d));
	return child;
}

async function waitFor (fn, ms = 30000, what = "условие") {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch { /* ещё не готово */ }
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`Не дождались: ${what}`);
}

/** Распознаёт QR-код из картинки на странице (как это сделала бы камера телефона). */
async function readQr (page, selector) {
	await page.waitForFunction((sel) => document.querySelector(sel)?.complete && document.querySelector(sel).naturalWidth > 0, selector);
	await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });
	return page.evaluate((sel) => {
		const img = document.querySelector(sel);
		const c = document.createElement("canvas");
		c.width = c.height = 600;
		const ctx = c.getContext("2d");
		ctx.drawImage(img, 0, 0, 600, 600);
		const code = window.jsQR(ctx.getImageData(0, 0, 600, 600).data, 600, 600);
		return code?.data ?? null;
	}, selector);
}

(async () => {
	fs.mkdirSync(out, { recursive: true });
	const studio = startStudio();
	const browser = await chromium.launch();
	try {
		await waitFor(async () => (await (await fetch(`${STUDIO}/api/onboarding/screen`)).json()).phase === "setup", 60000, "режим настройки");

		// ---------- 1. Экран: QR для подключения к сети зеркала ----------
		step("экран показывает QR для подключения к сети зеркала");
		const screenCtx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 0.5, timezoneId: "Europe/Moscow", locale: "ru-RU" });
		const screen = await screenCtx.newPage();
		await screen.goto(`${STUDIO}/screen`);
		await screen.waitForSelector("#setup:not([hidden])");
		const wifi = await readQr(screen, "#wifiQr");
		const password = await screen.textContent("#apPassword");
		assert.equal(wifi, `WIFI:T:WPA;S:SmartMirror-A1B2;P:${password};;`, `QR сети: ${wifi}`);
		const setupUrl = await readQr(screen, "#setupQr");
		assert.match(setupUrl, /^http:\/\/[\d.]+:8090\/setup$/, `QR страницы настройки: ${setupUrl}`);
		assert.ok(!setupUrl.includes("localhost") && !setupUrl.includes("127.0.0.1"), "адрес для телефона, а не для самого зеркала");
		await shot(screen, "1-screen-setup");
		const wide = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 0.5 })).newPage();
		await wide.goto(`${STUDIO}/screen`);
		await wide.waitForSelector("#setup:not([hidden])");
		await wide.waitForTimeout(500);
		await shot(wide, "1-screen-setup-landscape");
		await wide.close();

		// ---------- 2. Телефон: выбор сети и неверный пароль ----------
		step("телефон открывает страницу настройки и вводит неверный пароль");
		const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
		const phone = await phoneCtx.newPage();
		await phone.goto(setupUrl);
		await phone.waitForSelector('.nets button:has-text("HomeWiFi")');
		await shot(phone, "2-phone-networks");
		await phone.tap('.nets button:has-text("HomeWiFi")');
		await phone.fill("#password", "wrongpass");
		await shot(phone, "3-phone-password");
		await phone.tap("#connectBtn");
		await phone.waitForSelector("#waiting:not([hidden])");
		await screen.waitForSelector("#connecting:not([hidden])");
		assert.equal(await screen.textContent("#connectingTo"), "HomeWiFi");
		await shot(screen, "4-screen-connecting");
		await shot(phone, "4-phone-waiting");

		await screen.waitForSelector("#setupError:not([hidden])", { timeout: 20000 });
		assert.match(await screen.textContent("#setupError"), /Неверный пароль/);
		await phone.waitForSelector("#error:not([hidden])", { timeout: 10000 });
		assert.match(await phone.textContent("#error"), /Неверный пароль/);
		await shot(screen, "5-screen-error");
		await shot(phone, "5-phone-error");

		// ---------- 3. Верный пароль: зеркало в сети, MagicMirror² + QR для Studio ----------
		step("верный пароль: на экране MagicMirror² и QR для Studio");
		await phone.tap('.nets button:has-text("HomeWiFi")');
		await phone.fill("#password", "mirror2026");
		await phone.tap("#connectBtn");
		await phone.waitForSelector("#done:not([hidden])", { timeout: 20000 });
		await shot(phone, "6-phone-done");
		await screen.waitForSelector("#studioCard:not([hidden])", { timeout: 90000 });
		await screen.frameLocator("#mirror").locator(".region.top.left .clock").waitFor({ timeout: 30000 });
		await screen.waitForTimeout(3000);
		const pairUrl = await readQr(screen, "#studioQr");
		assert.match(pairUrl, /^http:\/\/[\d.]+:8090\/pair\?code=[\w-]+$/, `QR для Studio: ${pairUrl}`);
		await shot(screen, "7-screen-online");

		// ---------- 4. Без привязки менять зеркало нельзя ----------
		step("без QR телефон не может менять зеркало");
		const studioUrl = new URL("/", pairUrl).href;
		const stranger = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
		await stranger.goto(studioUrl);
		await stranger.waitForSelector("text=Отсканируйте QR-код на зеркале");
		const denied = await stranger.evaluate(async () => (await fetch("/api/reset", { method: "POST" })).status);
		assert.equal(denied, 401);
		const screenApi = await stranger.evaluate(async () => (await fetch("/api/onboarding/screen")).status);
		assert.equal(screenApi, 403, "пароль сети и код привязки не отдаются в сеть");
		await shot(stranger, "8-phone-not-paired");

		// ---------- 5. Привязка ----------
		step("телефон сканирует QR и открывает Studio");
		await phone.goto(pairUrl);
		await phone.waitForSelector(".chip");
		assert.equal(new URL(phone.url()).pathname, "/");
		await screen.waitForSelector("#paired:not([hidden])");
		assert.ok(await screen.locator("#studioCard").isHidden(), "QR исчез после привязки");
		await shot(screen, "9-screen-paired");
		await shot(phone, "9-phone-studio");
		await stranger.goto(pairUrl);
		await stranger.waitForSelector("#expired:not([hidden])");

		// ---------- 6. Виджет с телефона ----------
		step("телефон добавляет виджет и применяет — зеркало показывает его");
		await phone.tap('.tabs [data-tab="add"]');
		await phone.tap('.card:has-text("Текст")');
		await phone.locator("#tab-widget .field input[type=text]").nth(1).fill("Привет с телефона!");
		await phone.waitForFunction(() => !document.querySelector("#applyBtn").disabled);
		await phone.tap("#applyBtn");
		await phone.waitForSelector(".toast.ok", { timeout: 60000 });
		await screen.frameLocator("#mirror").locator("text=Привет с телефона!").waitFor({ timeout: 30000 });
		await screen.waitForTimeout(2000);
		await shot(screen, "10-screen-widget");

		// раздел «Зеркало» во вкладке «Вид»
		await phone.tap('.tabs [data-tab="look"]');
		await phone.waitForSelector('text=Wi‑Fi «HomeWiFi»');
		await phone.locator("text=Показать QR для другого телефона").scrollIntoViewIfNeeded();
		await shot(phone, "11-phone-device");

		// ---------- 7. Роутер выключился ----------
		step("роутер выключился: через паузу зеркало снова в режиме настройки");
		await fetch(`${STUDIO}/api/dev/network`, { method: "POST", body: JSON.stringify({ ssid: "HomeWiFi", up: false }) });
		await screen.waitForSelector("#offline:not([hidden])", { timeout: 10000 });
		await shot(screen, "12-screen-offline");
		await screen.waitForSelector("#setup:not([hidden])", { timeout: 20000 });
		assert.match(await screen.textContent("#setupError"), /Пропало подключение/);

		console.log(`E2E первого запуска: все проверки пройдены, снимки в ${out}`);
	} finally {
		await browser.close();
		studio.kill("SIGTERM");
	}
})().catch((e) => { console.error(e); process.exit(1); });

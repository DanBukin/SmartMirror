// Снимки экрана зеркала и Studio через Playwright (без Raspberry Pi).
// Запуск: NODE_PATH=$(npm root -g) node scripts/screenshot.js [папка]
const { chromium } = require("playwright");
const path = require("node:path");

const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "shots"));
const STUDIO = process.env.STUDIO_URL || "http://localhost:8090";
const MIRROR = process.env.MIRROR_URL || "http://localhost:8080";

(async () => {
	const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
	const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 0.5, timezoneId: "Europe/Moscow", locale: "ru-RU" });
	const mirror = await ctx.newPage();
	await mirror.goto(MIRROR);
	await mirror.waitForTimeout(6000);
	await mirror.screenshot({ path: path.join(out, "mirror.png") });

	const desk = await browser.newPage({ viewport: { width: 1360, height: 900 }, timezoneId: "Europe/Moscow" });
	await desk.goto(STUDIO);
	await desk.waitForSelector(".chip");
	await desk.click(".chip >> nth=0");
	await desk.waitForTimeout(400);
	await desk.screenshot({ path: path.join(out, "studio-desktop.png") });

	const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Europe/Moscow" });
	await phone.goto(STUDIO);
	await phone.waitForSelector(".chip");
	await phone.screenshot({ path: path.join(out, "studio-phone.png") });

	await browser.close();
	console.log(`Снимки сохранены в ${out}`);
})();

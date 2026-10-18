// Проверка сторонних модулей: курсы ЦБ (свой модуль), установка MMM-Jast и MMM-ISS-Live из GitHub,
// «свой модуль по ссылке», применение и отображение на зеркале.
// Запуск: NODE_PATH=$(npm root -g) node scripts/e2e-modules.js [папка для снимков]
const { chromium } = require("playwright");
const path = require("node:path");
const assert = require("node:assert/strict");

const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "shots"));
const STUDIO = process.env.STUDIO_URL || "http://localhost:8090";

(async () => {
	await fetch(`${STUDIO}/api/reset`, { method: "POST" });
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
	await page.goto(STUDIO);
	await page.waitForSelector(".chip");

	await page.click('.tabs [data-tab="add"]');
	await page.screenshot({ path: path.join(out, "studio-catalog.png") });

	// 1. Свой модуль курсов ЦБ — без установки
	await page.click('.card:has-text("Курсы валют ЦБ")');
	await page.waitForSelector('.region[data-pos="top_right"] .chip:has-text("Курсы ЦБ")');

	// 2. Сторонние модули: ставятся с GitHub при первом добавлении
	for (const [title, chipText] of [["Акции и криптовалюты", "Котировки"], ["МКС онлайн", "МКС онлайн"]]) {
		await page.click('.tabs [data-tab="add"]');
		await page.click(`.card:has-text("${title}")`);
		await page.waitForSelector(`.chip.selected:has-text("${chipText}")`, { timeout: 180000 });
		assert.equal(await page.locator(".chip.selected .chip-badge").count(), 0, `${title} установлен`);
	}
	// ставим МКС в центр
	await page.selectOption("#posSelect", "middle_center");

	// 3. Невалидная ссылка для «своего модуля» отклоняется сервером
	const bad = await fetch(`${STUDIO}/api/modules/install`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: "https://example.com/x; rm -rf /" }) });
	assert.equal(bad.status, 500);

	await page.waitForFunction(() => !document.querySelector("#applyBtn").disabled);
	await page.click("#applyBtn");
	await page.waitForSelector(".toast.ok", { timeout: 60000 });
	await page.click('.chip:has-text("Котировки")');
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(out, "studio-modules.png") });

	const mirrorPort = (await (await fetch(`${STUDIO}/api/mirror`)).json()).port;
	const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 0.5, timezoneId: "Europe/Moscow" });
	const mm = await ctx.newPage();
	await mm.goto(`http://127.0.0.1:${mirrorPort}`);
	await mm.waitForTimeout(8000);
	assert.match(await mm.locator(".cbr-rates").innerText(), /USD[\s\S]*₽/, "курсы ЦБ на зеркале");
	assert.equal(await mm.locator(".module.MMM-Jast").count(), 1, "MMM-Jast на зеркале");
	assert.equal(await mm.locator(".region.middle.center .module.MMM-ISS-Live").count(), 1, "МКС в центре");
	await mm.screenshot({ path: path.join(out, "mirror-modules.png") });

	await browser.close();
	console.log("E2E модулей: все проверки пройдены");
})().catch((e) => { console.error(e); process.exit(1); });

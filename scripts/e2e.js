// Сквозная проверка: перетащить виджет, добавить новый, применить и
// убедиться, что MagicMirror² показывает изменения.
// Запуск: NODE_PATH=$(npm root -g) node scripts/e2e.js [папка для снимков]
const { chromium } = require("playwright");
const path = require("node:path");
const assert = require("node:assert/strict");

const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "shots"));
const STUDIO = process.env.STUDIO_URL || "http://localhost:8090";
const MIRROR = process.env.MIRROR_URL || "http://localhost:8080";

async function dragTo (page, source, target) {
	const a = await page.locator(source).boundingBox();
	const b = await page.locator(target).boundingBox();
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
	await page.mouse.move(b.x + b.width / 2, b.y + b.height - 8, { steps: 12 });
	await page.mouse.up();
}

(async () => {
	const browser = await chromium.launch();
	// начинаем со стандартного макета
	await fetch(`${STUDIO}/api/reset`, { method: "POST" });
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
	await page.goto(STUDIO);
	await page.waitForSelector(".chip");

	// 1. Перетаскиваем «Задачи» из левого нижнего угла в правый нижний
	const todo = '.region[data-pos="bottom_left"] .chip:has-text("Задачи")';
	await dragTo(page, todo, '.region[data-pos="bottom_right"]');
	assert.equal(await page.locator('.region[data-pos="bottom_right"] .chip:has-text("Задачи")').count(), 1, "виджет переехал");

	// 2. Добавляем «Текст» и меняем надпись
	await page.click('.tabs [data-tab="add"]');
	await page.click('.card:has-text("Текст")');
	const input = page.locator("#tab-widget .field input[type=text]").nth(1);
	await input.fill("Привет из Studio!");
	await page.selectOption("#tab-widget select >> nth=1", "large");

	// 3. Переносим «Прогноз погоды» наверх правой колонки через кнопку «Выше»
	await page.click('.region[data-pos="top_right"] .chip:has-text("Прогноз")');
	await page.click('button:has-text("Выше")');
	await page.waitForTimeout(600);
	await page.screenshot({ path: path.join(out, "studio-edited.png") });

	// 4. Применяем
	await page.waitForFunction(() => !document.querySelector("#applyBtn").disabled);
	await page.click("#applyBtn");
	await page.waitForSelector(".toast.ok", { timeout: 40000 });

	// 5. Проверяем живое зеркало
	const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 0.5, timezoneId: "Europe/Moscow" });
	const mm = await ctx.newPage();
	await mm.goto(MIRROR);
	await mm.waitForTimeout(6000);
	assert.ok(await mm.locator(".region.bottom.right .simple-todo").isVisible(), "задачи справа внизу");
	assert.ok(await mm.locator(".region.upper.third:has-text('Привет из Studio!')").isVisible(), "текст в верхней трети");
	const headers = await mm.locator(".region.top.right .module").evaluateAll((els) => els.map((e) => e.querySelector(".module-header")?.textContent.trim() || ""));
	assert.match(headers[0], /прогноз/i, `прогноз первым в правой колонке: ${headers}`);
	await mm.screenshot({ path: path.join(out, "mirror-after.png") });

	// 6. Живой экран внутри Studio (на телефоне)
	const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	await phone.goto(`${STUDIO}/?view=live`);
	await phone.waitForTimeout(6000);
	await phone.screenshot({ path: path.join(out, "studio-phone-live.png") });

	await browser.close();
	console.log("E2E: все проверки пройдены");
})().catch((e) => { console.error(e); process.exit(1); });

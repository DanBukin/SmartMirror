// Проверка размера экрана и свободной раскладки: Studio → «Применить» → настоящее зеркало.
// Запуск при работающей Studio (--demo): NODE_PATH=$(npm root -g) node scripts/e2e-free.js [папка для снимков]
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "shots"));
const STUDIO = process.env.STUDIO_URL || "http://127.0.0.1:8090";
const MIRROR = process.env.MIRROR_URL || "http://127.0.0.1:8080";

(async () => {
	const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, timezoneId: "Europe/Moscow" });
	page.on("pageerror", (e) => console.error("Ошибка на странице:", e.message));
	await page.goto(STUDIO);
	await page.waitForSelector(".chip, .fbox");
	if (await page.evaluate(() => state.layout.placement === "free")) await page.click("[data-placement=regions]");
	await page.evaluate(() => { for (const w of state.layout.widgets) delete w.free; changed(); });

	// 1. размер экрана: 32″ 16:9 → сантиметры → «ширина × высота»
	await page.click("[data-tab=look]");
	const look = (label) => page.locator("#tab-look").getByLabel(label);
	const pick = (label, value) => look(label).selectOption(value);
	await pick("Как задать", "diagonal");
	await pick("Единицы", "in");
	await look("Диагональ").fill("32");
	await look("Диагональ").press("Tab");
	await pick("Соотношение", "16:9");
	await pick("Ориентация", "portrait");
	await page.waitForTimeout(200);
	let note = await page.textContent("#tab-look .note");
	assert.match(note, /39,8 см × 70,8 см/, note);
	const ratio = await page.evaluate(() => { const r = document.querySelector("#board").getBoundingClientRect(); return r.width / r.height; });
	assert.ok(Math.abs(ratio - 9 / 16) < 0.03, `пропорции схемы ${ratio}`);
	await pick("Единицы", "cm");
	assert.equal(await look("Диагональ").inputValue(), "81.3");
	await pick("Как задать", "size");
	const near = async (label, v) => assert.ok(Math.abs(Number(await look(label).inputValue()) - v) <= 0.11, `${label} ≈ ${v}`);
	await near("Ширина", 39.8);
	await page.click("[data-orient=landscape]");
	await near("Ширина", 70.8); // поворот меняет ширину и высоту местами
	await page.screenshot({ path: path.join(out, "screen-size.png") });
	await page.click("[data-orient=portrait]");
	console.log("✓ размер экрана: диагональ/размеры, дюймы/см, поворот");

	// 2. свободная раскладка: места берутся с живого зеркала
	await page.waitForFunction(() => Object.keys(state.measured).length >= 5, null, { timeout: 30000 });
	await page.click("[data-placement=free]");
	await page.waitForSelector(".fbox");
	const clockId = await page.evaluate(() => state.layout.widgets.find((w) => w.type === "clock").id);
	const m = await page.evaluate((id) => ({ free: state.layout.widgets.find((w) => w.id === id).free, measured: state.measured[id] }), clockId);
	assert.ok(Math.abs(m.free.x - m.measured.x) < 0.01 && Math.abs(m.free.y - m.measured.y) < 0.01, "часы остались там, где были на зеркале");
	const right = await page.evaluate(() => {
		const w = state.layout.widgets.find((x) => x.position === "top_right");
		return { free: w.free, m: state.measured[w.id] };
	});
	assert.equal(right.free.align, "right");
	assert.ok(Math.abs(right.free.x + right.free.w - (right.m.x + right.m.w)) < 0.01, "правый виджет прижат к тому же правому краю");
	console.log("✓ при переходе в «Свободно» виджеты остаются на своих местах");

	// перетаскиваем часы мышью в середину экрана (выбранный виджет лежит поверх остальных)
	await page.evaluate((id) => select(id, { switchTab: false }), clockId);
	const board = await page.locator("#board").boundingBox();
	const box = await page.locator(`.fbox[data-id=${clockId}]`).boundingBox();
	await page.mouse.move(box.x + 30, box.y + 10);
	await page.mouse.down();
	await page.mouse.move(box.x + 60, box.y + 60, { steps: 4 });
	const target = { x: board.x + board.width / 2 - box.width / 2 + 30 + 3, y: board.y + board.height * 0.45 };
	await page.mouse.move(target.x, target.y, { steps: 8 });
	await page.screenshot({ path: path.join(out, "free-drag.png") });
	await page.mouse.up();
	// и тянем правый край, делая виджет шире
	const box2 = await page.locator(`.fbox[data-id=${clockId}]`).boundingBox();
	await page.mouse.move(box2.x + box2.width - 4, box2.y + box2.height / 2);
	await page.mouse.down();
	await page.mouse.move(box2.x + box2.width + 40, box2.y + box2.height / 2, { steps: 6 });
	await page.mouse.up();
	const free = await page.evaluate((id) => state.layout.widgets.find((w) => w.id === id).free, clockId);
	assert.ok(free.y > 0.35 && free.y < 0.55, `y=${free.y}`);
	assert.ok(free.w > m.free.w, `ширина выросла: ${JSON.stringify([m.free, free, box2])}`);
	console.log("✓ перетаскивание и изменение ширины:", free);

	// координаты в панели — в сантиметрах
	const xInput = page.locator("#tab-widget").getByLabel("Слева");
	assert.ok(Math.abs(Number(await xInput.inputValue()) - free.x * 39.8) < 0.2, "X в сантиметрах");

	// 3. применяем и проверяем настоящее зеркало
	await page.waitForFunction(() => !state.saving);
	await page.click("#applyBtn");
	await page.waitForFunction(() => state.revision === state.appliedRevision && !document.querySelector("#applyBtn").disabled === false, null, { timeout: 90000 });
	await page.waitForFunction(() => state.mirror?.state === "running", null, { timeout: 90000 });
	await page.screenshot({ path: path.join(out, "free-studio.png") });

	const mirror = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 0.5, timezoneId: "Europe/Moscow" });
	await mirror.goto(MIRROR);
	await mirror.waitForSelector(`.module.sm-${clockId}`, { timeout: 30000 });
	await mirror.waitForTimeout(3000);
	const real = await mirror.locator(`.module.sm-${clockId}`).boundingBox();
	assert.ok(Math.abs(real.x - free.x * 1080) < 2 && Math.abs(real.y - free.y * 1920) < 2 && Math.abs(real.width - free.w * 1080) < 2, `на зеркале ${JSON.stringify(real)}`);
	await mirror.screenshot({ path: path.join(out, "free-mirror.png") });
	const statics = await mirror.evaluate(() => [...document.querySelectorAll(".module[class*=sm-]")].filter((n) => getComputedStyle(n).position !== "fixed").map((n) => n.className));
	assert.deepEqual(statics, [], "все виджеты стоят на своих местах");
	console.log("✓ на зеркале часы стоят там же, где на схеме:", real);

	await page.click("[data-view=live]");
	await page.waitForTimeout(4000);
	await page.screenshot({ path: path.join(out, "free-live.png") });

	const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Europe/Moscow" });
	await phone.goto(STUDIO);
	await phone.waitForSelector(".fbox");
	await phone.waitForTimeout(1500);
	await phone.screenshot({ path: path.join(out, "free-phone.png") });

	await browser.close();
	console.log(`Готово, снимки в ${out}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Onboarding } = require("../lib/onboarding");
const { MockNetwork } = require("../lib/network/mock");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sm-onb-"));
const until = async (fn, ms = 3000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("не дождались");
};

function make (opts = {}) {
	const dir = opts.dir || tmp();
	const network = opts.network || new MockNetwork({ file: path.join(dir, "wifi.json"), delay: 5 });
	const events = [];
	const ob = new Onboarding({
		network, file: path.join(dir, "device.json"), studioPort: 8090,
		bootWait: 20, offlineGrace: 30, retryEvery: 30, idleBeforeRetry: 0, tick: 1e6,
		onOnline: () => events.push("online"), log: () => {}, ...opts
	});
	return { ob, network, events, dir };
}

test("без знакомой сети зеркало раздаёт свою и показывает QR", async () => {
	const { ob, network } = make();
	await ob.start();
	ob.stop();
	const s = ob.screenState();
	assert.equal(s.phase, "setup");
	assert.match(s.ap.ssid, /^SmartMirror-A1B2$/);
	assert.equal(s.ap.password.length, 8);
	assert.equal(ob.wifiQrText(), `WIFI:T:WPA;S:${s.ap.ssid};P:${s.ap.password};;`);
	assert.equal(s.studio, null, "QR для Studio — только когда зеркало в сети");
	assert.ok((await network.status()).apActive);
	assert.ok(ob.setupState().networks.some((n) => n.ssid === "HomeWiFi"), "сети найдены до включения точки доступа");
});

test("неверный пароль: снова режим настройки с ошибкой; верный — в сети", async () => {
	const { ob, network, events } = make();
	await ob.start();
	ob.stop();
	assert.equal(ob.connect("HomeWiFi", "short").ok, false, "пароль короче 8 символов отклоняется сразу");
	assert.equal(ob.connect("HomeWiFi", "wrongpass").ok, true);
	assert.equal(ob.phase, "connecting");
	await until(() => ob.phase === "setup");
	assert.match(ob.lastError, /HomeWiFi.*Неверный пароль/);
	assert.ok((await network.status()).apActive, "точка доступа снова включена");

	ob.connect("HomeWiFi", "mirror2026");
	await until(() => ob.phase === "online");
	assert.deepEqual(events, ["online"]);
	assert.equal(ob.lastError, null);
	const s = ob.screenState();
	assert.equal(s.network.ssid, "HomeWiFi");
	assert.equal(s.ap, null, "пароль своей сети больше не показываем");
	assert.match(s.studio.pairUrl, /^http:\/\/[\d.]+:8090\/pair\?code=[\w-]{12}$/);
	assert.equal(ob.connect("HomeWiFi", "mirror2026").ok, false, "в сети настройка Wi‑Fi закрыта");
});

test("после перезагрузки зеркало помнит Wi‑Fi и сразу показывает MagicMirror²", async () => {
	const dir = tmp();
	const first = make({ dir });
	await first.ob.start();
	first.ob.stop();
	first.ob.connect("Cafe_Free", "");
	await until(() => first.ob.phase === "online");

	const network = new MockNetwork({ file: path.join(dir, "wifi.json"), delay: 5 });
	await network.reconnectKnown(); // так NetworkManager сам подключается при загрузке
	const again = make({ dir, network });
	await again.ob.start();
	again.ob.stop();
	assert.equal(again.ob.phase, "online");
	assert.deepEqual(again.events, [], "MagicMirror² не перезапускается, если сеть была сразу");
	assert.equal(again.ob.store.ap.ssid, first.ob.store.ap.ssid, "имя и пароль своей сети не меняются");
});

test("привязка: код одноразовый, токен работает, отвязка", async () => {
	const { ob } = make();
	const code = ob.pairingCode();
	assert.equal(ob.pair("чужой-код-123"), null);
	const token = ob.pair(code, "Mozilla/5.0 (iPhone)");
	assert.ok(token);
	assert.ok(ob.isPaired(token));
	assert.equal(ob.isPaired("x"), false);
	assert.equal(ob.pair(code), null, "второй раз тот же код не работает");
	assert.ok(!JSON.stringify(ob.store).includes(token), "токен хранится только как хеш");
	ob.phase = "online";
	assert.equal(ob.screenState().studio, null, "телефон привязан — QR скрыт");
	assert.equal(ob.screenState().justPaired, true);
	ob.showQr();
	assert.ok(ob.screenState().studio, "QR для второго телефона");
	const [d] = ob.devices();
	assert.ok(ob.unpair(d.id));
	assert.equal(ob.isPaired(token), false);
});

test("сеть пропала: через паузу — режим настройки; роутер вернулся — снова в сети", async () => {
	const { ob, network, events } = make();
	await network.connect("HomeWiFi", "mirror2026");
	await ob.start();
	ob.stop();
	assert.equal(ob.phase, "online");

	network.setRouter("HomeWiFi", false);
	await ob.tick();
	assert.equal(ob.phase, "online", "короткий обрыв не сбрасывает настройку");
	assert.ok(ob.screenState().network.offline);
	await new Promise((r) => setTimeout(r, 40));
	await ob.tick();
	assert.equal(ob.phase, "setup");
	assert.match(ob.lastError, /Пропало подключение/);

	network.setRouter("HomeWiFi", true);
	await new Promise((r) => setTimeout(r, 40));
	await ob.tick();
	assert.equal(ob.phase, "online", "точка доступа выключилась, зеркало вернулось к домашнему Wi‑Fi");
	assert.deepEqual(events, ["online"]);
});

test("смена сети по просьбе телефона", async () => {
	const { ob, network } = make();
	await network.connect("HomeWiFi", "mirror2026");
	await ob.start();
	ob.stop();
	assert.ok(ob.changeNetwork().ok);
	await until(() => ob.phase === "setup" && !ob.busy);
	assert.ok((await network.status()).apActive);
});

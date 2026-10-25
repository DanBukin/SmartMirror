"use strict";

// NmcliNetwork против поддельного nmcli: проверяем, какие команды уходят в
// NetworkManager и как разбирается его вывод. Настоящий nmcli — только на Pi.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { NmcliNetwork, splitTerse, explain } = require("../lib/network/nmcli");

/** Поддельный nmcli: пишет аргументы в журнал и отвечает по таблице «аргументы → ответ». */
function fakeNmcli (answers) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-nmcli-"));
	const log = path.join(dir, "calls.log");
	const table = path.join(dir, "answers.json");
	fs.writeFileSync(table, JSON.stringify(answers));
	const bin = path.join(dir, "nmcli");
	fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(table)}, "utf8"));
const hit = answers.find((a) => args.join(" ").includes(a.match));
if (hit?.stderr) process.stderr.write(hit.stderr);
process.stdout.write(hit?.stdout || "");
process.exit(hit?.code || 0);
`, { mode: 0o755 });
	const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
	return { net: new NmcliNetwork({ bin, ifname: "wlan0", leasesFile: path.join(dir, "leases") }), calls, dir };
}

test("splitTerse учитывает экранирование nmcli", () => {
	assert.deepEqual(splitTerse("yes:My\\:Net:80"), ["yes", "My:Net", "80"]);
	assert.deepEqual(splitTerse("DC\\:A6\\:32\\:01\\:02\\:03"), ["DC:A6:32:01:02:03"]);
	assert.deepEqual(splitTerse("a\\\\b:c"), ["a\\b", "c"]);
});

test("понятные ошибки", () => {
	assert.equal(explain("Error: Connection activation failed: Secrets were required, but not provided."), "Неверный пароль Wi‑Fi");
	assert.match(explain("Error: No network with SSID 'X' found."), /Сеть не найдена/);
});

test("status: Wi‑Fi подключён, своя точка доступа выключена", async () => {
	const { net } = fakeNmcli([
		{ match: "DEVICE,TYPE,STATE,CONNECTION device", stdout: "wlan0:wifi:connected:HomeWiFi\nlo:loopback:connected (externally):lo\np2p-dev-wlan0:wifi-p2p:disconnected:\n" },
		{ match: "IP4.ADDRESS device show wlan0", stdout: "192.168.1.23/24\n" },
		{ match: "ACTIVE,SSID device wifi list", stdout: "no:Neighbor\nyes:Home\\:WiFi\n" }
	]);
	assert.deepEqual(await net.status(), { connected: true, apActive: false, ssid: "Home:WiFi", ip: "192.168.1.23", via: "wifi" });
});

test("status: работает точка доступа — значит, не в сети", async () => {
	const { net } = fakeNmcli([{ match: "DEVICE,TYPE,STATE,CONNECTION device", stdout: "wlan0:wifi:connected:SmartMirror-Setup\neth0:ethernet:unavailable:\n" }]);
	const s = await net.status();
	assert.equal(s.connected, false);
	assert.equal(s.apActive, true);
});

test("status: кабель тоже считается подключением", async () => {
	const { net } = fakeNmcli([
		{ match: "DEVICE,TYPE,STATE,CONNECTION device", stdout: "eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:\n" },
		{ match: "IP4.ADDRESS device show eth0", stdout: "10.0.0.5/24 | 10.0.0.6/24\n" }
	]);
	assert.deepEqual(await net.status(), { connected: true, apActive: false, ssid: null, ip: "10.0.0.5", via: "ethernet" });
});

test("scan: без дублей, своей сети и скрытых, сильные сверху", async () => {
	const { net, calls } = fakeNmcli([{ match: "SSID,SIGNAL,SECURITY", stdout: "Home:40:WPA2\nHome:80:WPA2\n:70:WPA2\nCafe:55:\nSmartMirror-A1B2:99:WPA2\nOld:20:--\n" }]);
	assert.deepEqual(await net.scan(), [
		{ ssid: "Home", signal: 80, secure: true },
		{ ssid: "Cafe", signal: 55, secure: false },
		{ ssid: "Old", signal: 20, secure: false }
	]);
	assert.deepEqual(calls()[0].slice(-2), ["--rescan", "yes"]);
});

test("startAp: точка доступа WPA2 с общим доступом на 10.42.0.1", async () => {
	const { net, calls } = fakeNmcli([]);
	assert.deepEqual(await net.startAp({ ssid: "SmartMirror-A1B2", password: "abcdefgh" }), { ok: true, ip: "10.42.0.1" });
	const [del, add, up] = calls();
	assert.deepEqual(del, ["connection", "delete", "id", "SmartMirror-Setup"]);
	const opt = (k) => add[add.indexOf(k) + 1];
	assert.equal(opt("ssid"), "SmartMirror-A1B2");
	assert.equal(opt("802-11-wireless.mode"), "ap");
	assert.equal(opt("ipv4.method"), "shared");
	assert.equal(opt("ipv4.addresses"), "10.42.0.1/24");
	assert.equal(opt("wifi-sec.psk"), "abcdefgh");
	assert.equal(opt("autoconnect"), "no", "после перезагрузки точка доступа сама не включается");
	assert.deepEqual(up, ["connection", "up", "id", "SmartMirror-Setup"]);
});

test("connect: неверный пароль — профиль удаляется, если его создали мы", async () => {
	const { net, calls } = fakeNmcli([
		{ match: "NAME connection show", stdout: "SmartMirror-Setup\nWired connection 1\n" },
		{ match: "device wifi connect", code: 4, stderr: "Error: Connection activation failed: Secrets were required, but not provided.\n" }
	]);
	assert.deepEqual(await net.connect("HomeWiFi", "wrongpass"), { ok: false, error: "Неверный пароль Wi‑Fi" });
	const c = calls();
	assert.deepEqual(c[1], ["-w", "40", "device", "wifi", "connect", "HomeWiFi", "ifname", "wlan0", "password", "wrongpass"]);
	assert.deepEqual(c[2], ["connection", "delete", "id", "HomeWiFi"]);
});

test("connect: старый профиль с тем же именем не трогаем; скрытая сеть", async () => {
	const { net, calls } = fakeNmcli([
		{ match: "NAME connection show", stdout: "HomeWiFi\n" },
		{ match: "device wifi connect", code: 4, stderr: "Error: timeout\n" }
	]);
	await net.connect("HomeWiFi", "whatever1", { hidden: true });
	const c = calls();
	assert.deepEqual(c[1].slice(-2), ["hidden", "yes"]);
	assert.equal(c.length, 2);
});

test("apClients считает действующие аренды dnsmasq", async () => {
	const { net, dir } = fakeNmcli([]);
	const now = Math.floor(Date.now() / 1000);
	fs.writeFileSync(path.join(dir, "leases"), `${now + 3600} aa:bb 10.42.0.23 iPhone *\n${now - 10} cc:dd 10.42.0.24 old *\n`);
	assert.equal(await net.apClients(), 1);
});

test("deviceSuffix и forget", async () => {
	const { net, calls } = fakeNmcli([
		{ match: "GENERAL.HWADDR", stdout: "DC\\:A6\\:32\\:12\\:AB\\:CD\n" },
		{ match: "NAME,TYPE connection show", stdout: "HomeWiFi:802-11-wireless\nSmartMirror-Setup:802-11-wireless\nWired connection 1:802-3-ethernet\n" }
	]);
	assert.equal(await net.deviceSuffix(), "ABCD");
	await net.forget();
	assert.deepEqual(calls().at(-1), ["connection", "delete", "id", "HomeWiFi"]);
});

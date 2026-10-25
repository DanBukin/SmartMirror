"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");

/**
 * Wi‑Fi на Raspberry Pi OS (Bookworm и новее) через NetworkManager.
 * Все вызовы — `nmcli` без оболочки, аргументы передаются списком.
 * Сервису нужно право управлять сетью: правило polkit ставит pi/install.sh.
 */

const AP_CON = "SmartMirror-Setup";
const AP_IP = "10.42.0.1";

/** Разбивает строку `nmcli -t` по двоеточиям, учитывая экранирование `\:` и `\\`. */
function splitTerse (line) {
	const out = [];
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) cur += line[++i];
		else if (ch === ":") {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

/** Понятная причина по тексту ошибки nmcli. */
function explain (stderr) {
	const s = String(stderr);
	if (/secrets were required|802-1x|psk|password/i.test(s)) return "Неверный пароль Wi‑Fi";
	if (/no network with ssid/i.test(s)) return "Сеть не найдена — проверьте, что роутер рядом и название верное";
	if (/timeout|timed out/i.test(s)) return "Роутер не ответил вовремя";
	if (/not authorized|insufficient privileges/i.test(s)) return "Нет прав на управление Wi‑Fi (запустите pi/install.sh)";
	return s.trim().split("\n").pop() || "Не удалось подключиться";
}

class NmcliNetwork {
	constructor ({ ifname = process.env.WIFI_IFACE || "wlan0", bin = process.env.NMCLI_BIN || "nmcli", leasesFile } = {}) {
		this.ifname = ifname;
		this.bin = bin;
		this.leasesFile = leasesFile || `/var/lib/NetworkManager/dnsmasq-${ifname}.leases`;
		this.apIp = AP_IP;
	}

	run (args, { timeout = 45000 } = {}) {
		return new Promise((resolve) => {
			execFile(this.bin, args, { timeout, env: { ...process.env, LC_ALL: "C" } }, (err, stdout, stderr) => {
				resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr || err?.message || "") });
			});
		});
	}

	async lines (args) {
		const r = await this.run(args);
		return r.ok ? r.stdout.split("\n").filter(Boolean).map(splitTerse) : [];
	}

	/** Подключено ли устройство к сети (Wi‑Fi как клиент или кабель) и поднята ли своя точка доступа. */
	async status () {
		const devices = await this.lines(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"]);
		let online = null;
		let apActive = false;
		for (const [device, type, state, connection] of devices) {
			if (!state?.startsWith("connected") || state.includes("connecting")) continue;
			if (connection === AP_CON) apActive = true;
			else if ((type === "wifi" || type === "ethernet") && !online) online = { device, type, connection };
		}
		if (!online) return { connected: false, apActive, ssid: null, ip: null, via: null };
		const [ip] = (await this.lines(["-t", "-g", "IP4.ADDRESS", "device", "show", online.device]))[0] || [];
		let ssid = online.connection;
		if (online.type === "wifi") {
			const active = (await this.lines(["-t", "-f", "ACTIVE,SSID", "device", "wifi", "list", "ifname", this.ifname, "--rescan", "no"])).find((l) => l[0] === "yes");
			if (active) ssid = active[1];
		}
		return { connected: true, apActive, ssid: online.type === "wifi" ? ssid : null, ip: ip ? ip.split(" | ")[0].split("/")[0] : null, via: online.type };
	}

	/** Сети вокруг. Пока работает точка доступа, свежий поиск недоступен — отдаём то, что NetworkManager видел последним. */
	async scan ({ rescan = true } = {}) {
		const rows = await this.lines(["-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", this.ifname, "--rescan", rescan ? "yes" : "no"]);
		const best = new Map();
		for (const [ssid, signal, security] of rows) {
			if (!ssid || ssid.startsWith("SmartMirror-")) continue;
			const item = { ssid, signal: Number(signal) || 0, secure: Boolean(security && security !== "--") };
			if (!best.has(ssid) || best.get(ssid).signal < item.signal) best.set(ssid, item);
		}
		return [...best.values()].sort((a, b) => b.signal - a.signal);
	}

	async #profileExists (name) {
		return (await this.lines(["-t", "-f", "NAME", "connection", "show"])).some(([n]) => n === name);
	}

	async connect (ssid, password, { hidden = false } = {}) {
		const existed = await this.#profileExists(ssid);
		const args = ["-w", "40", "device", "wifi", "connect", ssid, "ifname", this.ifname];
		if (password) args.push("password", password);
		if (hidden) args.push("hidden", "yes");
		const r = await this.run(args, { timeout: 60000 });
		if (r.ok) return { ok: true };
		// неудачная попытка оставляет профиль с неверным паролем — убираем, если его создали мы
		if (!existed) await this.run(["connection", "delete", "id", ssid]);
		return { ok: false, error: explain(r.stderr) };
	}

	async startAp ({ ssid, password }) {
		await this.run(["connection", "delete", "id", AP_CON]);
		const add = await this.run([
			"connection", "add", "type", "wifi", "ifname", this.ifname, "con-name", AP_CON, "autoconnect", "no", "ssid", ssid,
			"802-11-wireless.mode", "ap", "802-11-wireless.band", "bg", "802-11-wireless.channel", "6",
			"ipv4.method", "shared", "ipv4.addresses", `${AP_IP}/24`, "ipv6.method", "disabled",
			"wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.proto", "rsn", "wifi-sec.pairwise", "ccmp", "wifi-sec.group", "ccmp", "wifi-sec.psk", password
		]);
		if (!add.ok) return { ok: false, error: explain(add.stderr) };
		const up = await this.run(["connection", "up", "id", AP_CON]);
		return up.ok ? { ok: true, ip: AP_IP } : { ok: false, error: explain(up.stderr) };
	}

	async stopAp () {
		await this.run(["connection", "down", "id", AP_CON]);
	}

	/** Просим NetworkManager подключиться к любой сохранённой сети, которая сейчас в зоне видимости. */
	async reconnectKnown () {
		const r = await this.run(["-w", "30", "device", "connect", this.ifname]);
		return r.ok && (await this.status()).connected;
	}

	/** Сколько телефонов получили адрес от точки доступа (по файлу аренды dnsmasq). */
	async apClients () {
		try {
			const now = Date.now() / 1000;
			return fs.readFileSync(this.leasesFile, "utf8").split("\n").filter((l) => Number(l.split(" ")[0]) > now).length;
		} catch {
			return 0;
		}
	}

	/** Забывает сохранённые сети Wi‑Fi (кроме своей точки доступа). */
	async forget (ssid) {
		const rows = await this.lines(["-t", "-f", "NAME,TYPE", "connection", "show"]);
		for (const [name, type] of rows) {
			if (name !== AP_CON && type === "802-11-wireless" && (!ssid || name === ssid)) await this.run(["connection", "delete", "id", name]);
		}
	}

	/** Последние 4 символа MAC Wi‑Fi — чтобы у каждого зеркала было своё имя сети. */
	async deviceSuffix () {
		const [mac] = (await this.lines(["-t", "-g", "GENERAL.HWADDR", "device", "show", this.ifname]))[0] || [];
		return mac ? mac.replace(/[^0-9a-f]/gi, "").slice(-4).toUpperCase() : null;
	}
}

module.exports = { NmcliNetwork, splitTerse, explain, AP_CON, AP_IP };

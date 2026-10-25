"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Виртуальный Wi‑Fi для разработки без Raspberry Pi. Ведёт себя как NmcliNetwork:
 * видит несколько сетей, проверяет пароль, поднимает «точку доступа».
 * Сохранённые сети хранятся в файле, поэтому «перезагрузка» помнит домашний Wi‑Fi.
 *
 * Вместо адресов Pi (10.42.0.1 и адрес в домашней сети) — настоящий адрес этого компьютера,
 * поэтому QR-коды на виртуальном экране можно сканировать настоящим телефоном в той же сети.
 *
 * Сети по умолчанию: HomeWiFi (пароль mirror2026), Rostelecom_5G (пароль 12345678),
 * Cafe_Free (без пароля). Свой список — переменная MOCK_WIFI в JSON.
 */

const DEFAULT_NETWORKS = [
	{ ssid: "HomeWiFi", signal: 86, password: "mirror2026" },
	{ ssid: "Rostelecom_5G", signal: 61, password: "12345678" },
	{ ssid: "Cafe_Free", signal: 38, password: "" },
	{ ssid: "TP-Link_7A2C", signal: 24, password: "password1" }
];

/** Адрес компьютера в локальной сети (первый не внутренний IPv4). */
function lanIp () {
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
	}
	return "127.0.0.1";
}

class MockNetwork {
	constructor ({ file, networks, delay = Number(process.env.MOCK_WIFI_DELAY ?? 1500) } = {}) {
		this.file = file;
		this.delay = delay;
		this.networks = networks || (process.env.MOCK_WIFI ? JSON.parse(process.env.MOCK_WIFI) : DEFAULT_NETWORKS);
		this.saved = this.#load();
		this.current = null; // ssid, к которому подключены
		this.ap = null;
		this.clients = 0;
		this.apIp = process.env.MOCK_WIFI_IP || lanIp();
		this.log = []; // что «делали с Wi‑Fi», для проверок
	}

	#load () {
		try {
			return JSON.parse(fs.readFileSync(this.file, "utf8")).saved || {};
		} catch {
			return {};
		}
	}

	#save () {
		if (!this.file) return;
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify({ saved: this.saved }, null, 2));
	}

	#wait (k = 1) {
		return new Promise((r) => setTimeout(r, this.delay * k));
	}

	#visible (ssid) {
		return this.networks.find((n) => n.ssid === ssid && !n.down);
	}

	async status () {
		return {
			connected: Boolean(this.current),
			apActive: Boolean(this.ap),
			ssid: this.current,
			ip: this.current ? this.apIp : null,
			via: this.current ? "wifi" : null
		};
	}

	async scan () {
		this.log.push("scan");
		return this.networks.filter((n) => !n.down).map((n) => ({ ssid: n.ssid, signal: n.signal, secure: Boolean(n.password) }))
			.sort((a, b) => b.signal - a.signal);
	}

	async connect (ssid, password) {
		this.log.push(`connect ${ssid}`);
		if (this.ap) return { ok: false, error: "Точка доступа ещё работает" };
		await this.#wait(1);
		const net = this.#visible(ssid);
		if (!net) return { ok: false, error: "Сеть не найдена — проверьте, что роутер рядом и название верное" };
		if (net.password && net.password !== password) return { ok: false, error: "Неверный пароль Wi‑Fi" };
		this.current = ssid;
		this.saved[ssid] = password || "";
		this.#save();
		return { ok: true };
	}

	async startAp ({ ssid }) {
		this.log.push(`ap up ${ssid}`);
		await this.#wait(0.3);
		this.current = null; // одно радио: точка доступа вытесняет подключение к роутеру
		this.ap = { ssid };
		return { ok: true, ip: this.apIp };
	}

	async stopAp () {
		if (!this.ap) return;
		this.log.push("ap down");
		await this.#wait(0.3);
		this.ap = null;
		this.clients = 0;
	}

	async reconnectKnown () {
		this.log.push("reconnect");
		if (this.ap) return false;
		await this.#wait(0.5);
		const known = this.networks.find((n) => !n.down && n.ssid in this.saved && this.saved[n.ssid] === (n.password || ""));
		this.current = known ? known.ssid : null;
		return Boolean(known);
	}

	async apClients () {
		return this.ap ? this.clients : 0;
	}

	async forget (ssid) {
		for (const k of Object.keys(this.saved)) if (!ssid || k === ssid) delete this.saved[k];
		this.#save();
	}

	async deviceSuffix () {
		return "A1B2";
	}

	// ---------- управление «окружением» из тестов (/api/dev/network) ----------

	/** Роутер выключился / включился. */
	setRouter (ssid, up) {
		const net = this.networks.find((n) => n.ssid === ssid);
		if (!net) return false;
		net.down = !up;
		if (!up && this.current === ssid) this.current = null;
		return true;
	}
}

module.exports = { MockNetwork, DEFAULT_NETWORKS };

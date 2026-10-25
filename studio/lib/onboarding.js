"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Первый запуск зеркала и связь с телефоном.
 *
 *   booting ──(сеть есть)──────────────────────────────► online
 *      │                                                   │ ▲
 *      └─(сети нет)─► setup ──(телефон прислал Wi‑Fi)─► connecting
 *                      ▲  ▲                                │
 *                      │  └──────(неверный пароль)─────────┘
 *                      └──────(сеть пропала надолго)───── online
 *
 * setup: зеркало раздаёт свою сеть SmartMirror-XXXX, на экране QR для подключения.
 * online: на экране MagicMirror², пока ни один телефон не привязан — QR со ссылкой на Studio.
 *
 * Привязка: в QR зашит одноразовый код. Телефон открывает /pair?code=…, получает токен
 * (cookie), и только с ним может менять макет. Хранятся хеши токенов.
 */

const CODE_TTL = 10 * 60 * 1000;

class Onboarding {
	constructor ({ network, file, studioPort, captivePort = null, bootWait = 25000, offlineGrace = 60000, retryEvery = 5 * 60000, idleBeforeRetry = 2 * 60000, tick = 5000, onOnline = () => {}, log = console.log }) {
		this.net = network;
		this.file = file;
		this.studioPort = studioPort;
		this.captivePort = captivePort;
		this.bootWait = bootWait;
		this.offlineGrace = offlineGrace;
		this.retryEvery = retryEvery;
		this.idleBeforeRetry = idleBeforeRetry;
		this.tickMs = tick;
		this.onOnline = onOnline;
		this.log = log;

		this.phase = "booting";
		this.lastError = null;
		this.connectingTo = null;
		this.networks = [];
		this.link = { connected: false, ssid: null, ip: null }; // последнее состояние сети
		this.offlineSince = null;
		this.lastSetupActivity = 0;
		this.lastRetry = 0;
		this.pairCode = null;
		this.pairCodeAt = 0;
		this.showQrUntil = 0;
		this.pairedAt = 0; // когда привязали последний телефон — экран показывает «Телефон подключён»
		this.timer = null;
		this.busy = false;

		this.store = this.#load();
	}

	#load () {
		let s = {};
		try {
			s = JSON.parse(fs.readFileSync(this.file, "utf8"));
		} catch { /* первый запуск */ }
		return { ap: s.ap || null, devices: Array.isArray(s.devices) ? s.devices : [] };
	}

	#save () {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
	}

	/** Имя и пароль своей сети: генерируются один раз и не меняются. */
	async #apCredentials () {
		if (!this.store.ap) {
			const suffix = (await this.net.deviceSuffix()) || crypto.randomBytes(2).toString("hex").toUpperCase();
			// без похожих символов (0/o, 1/l), чтобы пароль можно было набрать с экрана
			const abc = "abcdefghjkmnpqrstuvwxyz23456789";
			const password = Array.from(crypto.randomBytes(8), (b) => abc[b % abc.length]).join("");
			this.store.ap = { ssid: `SmartMirror-${suffix}`, password };
			this.#save();
		}
		return this.store.ap;
	}

	// ---------- жизненный цикл ----------

	async start () {
		const until = Date.now() + this.bootWait;
		do {
			this.link = await this.net.status();
			if (this.link.connected) break;
			await new Promise((r) => setTimeout(r, Math.min(1000, this.bootWait)));
		} while (Date.now() < until);

		if (this.link.connected) this.#goOnline({ fresh: false });
		else await this.enterSetup();
		this.timer = setInterval(() => this.tick().catch((e) => this.log(`[onboarding] ${e.message}`)), this.tickMs);
		this.timer.unref?.();
	}

	stop () {
		clearInterval(this.timer);
	}

	#goOnline ({ fresh }) {
		this.phase = "online";
		this.connectingTo = null;
		this.lastError = null;
		this.offlineSince = null;
		this.log(`[onboarding] в сети: ${this.link.ssid || this.link.via} ${this.link.ip || ""}`);
		if (fresh) this.onOnline();
	}

	async enterSetup (reason = null) {
		if (reason) this.lastError = reason;
		this.phase = "setup";
		this.connectingTo = null;
		this.offlineSince = null;
		// сначала ищем сети: пока работает точка доступа, свежий поиск недоступен
		this.networks = await this.net.scan().catch(() => this.networks);
		const ap = await this.#apCredentials();
		const r = await this.net.startAp(ap);
		if (!r.ok) {
			this.lastError = `Не удалось включить точку доступа: ${r.error}`;
			this.log(`[onboarding] ${this.lastError}`);
		} else this.log(`[onboarding] точка доступа ${ap.ssid} на ${r.ip}`);
		this.link = await this.net.status();
		this.lastRetry = Date.now();
	}

	/** Телефон прислал домашний Wi‑Fi. Отвечаем сразу, подключаемся в фоне. */
	connect (ssid, password, { hidden = false } = {}) {
		ssid = String(ssid || "").trim();
		password = String(password || "");
		if (this.phase !== "setup") return { ok: false, error: "Зеркало сейчас не в режиме настройки" };
		if (!ssid || ssid.length > 32) return { ok: false, error: "Укажите название сети" };
		if (password && (password.length < 8 || password.length > 63)) return { ok: false, error: "Пароль Wi‑Fi — от 8 до 63 символов" };
		this.phase = "connecting";
		this.connectingTo = ssid;
		this.lastError = null;
		this.#run(async () => {
			await this.net.stopAp();
			const r = await this.net.connect(ssid, password, { hidden });
			this.link = await this.net.status();
			if (r.ok && this.link.connected) this.#goOnline({ fresh: true });
			else await this.enterSetup(`«${ssid}»: ${r.error || "не удалось подключиться"}`);
		});
		return { ok: true };
	}

	/** Перейти в режим настройки по просьбе привязанного телефона (переезд, новый роутер). */
	changeNetwork () {
		if (this.phase !== "online") return { ok: false, error: "Зеркало уже в режиме настройки" };
		this.#run(() => this.enterSetup());
		return { ok: true };
	}

	async #run (fn) {
		this.busy = true;
		try {
			await fn();
		} catch (e) {
			this.log(`[onboarding] ${e.stack || e.message}`);
		} finally {
			this.busy = false;
		}
	}

	/** Сторож: сеть пропала — через offlineGrace включаем настройку; в настройке иногда пробуем знакомые сети. */
	async tick () {
		if (this.busy) return;
		if (this.phase === "online") {
			this.link = await this.net.status();
			if (this.link.connected) {
				this.offlineSince = null;
				return;
			}
			this.offlineSince ??= Date.now();
			if (Date.now() - this.offlineSince >= this.offlineGrace) {
				await this.#run(() => this.enterSetup("Пропало подключение к Wi‑Fi"));
			}
			return;
		}
		if (this.phase === "setup") {
			// роутер могли просто перезагрузить: если к точке доступа никто не подключён,
			// время от времени выключаем её и пробуем сохранённые сети
			const idle = Date.now() - this.lastSetupActivity > this.idleBeforeRetry && (await this.net.apClients()) === 0;
			if (idle && Date.now() - this.lastRetry >= this.retryEvery) {
				await this.#run(async () => {
					this.lastRetry = Date.now();
					await this.net.stopAp();
					if (await this.net.reconnectKnown()) {
						this.link = await this.net.status();
						this.#goOnline({ fresh: true });
					} else await this.enterSetup();
				});
			}
		}
	}

	touchSetup () {
		this.lastSetupActivity = Date.now();
	}

	// ---------- привязка телефона ----------

	#hash (token) {
		return crypto.createHash("sha256").update(String(token)).digest("hex");
	}

	/** Действующий одноразовый код для QR (обновляется раз в 10 минут и после каждой привязки). */
	pairingCode () {
		if (!this.pairCode || Date.now() - this.pairCodeAt > CODE_TTL) {
			this.pairCode = crypto.randomBytes(9).toString("base64url");
			this.pairCodeAt = Date.now();
		}
		return this.pairCode;
	}

	pair (code, name = "") {
		if (!code || !this.pairCode || Date.now() - this.pairCodeAt > CODE_TTL) return null;
		const a = Buffer.from(String(code));
		const b = Buffer.from(this.pairCode);
		if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
		const token = crypto.randomBytes(24).toString("base64url");
		this.store.devices.push({ id: crypto.randomBytes(4).toString("hex"), hash: this.#hash(token), name: String(name).slice(0, 120), createdAt: new Date().toISOString() });
		this.#save();
		this.pairCode = null; // код одноразовый
		this.showQrUntil = 0;
		this.pairedAt = Date.now();
		return token;
	}

	isPaired (token) {
		if (!token) return false;
		const h = this.#hash(token);
		return this.store.devices.some((d) => d.hash === h);
	}

	devices () {
		return this.store.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt }));
	}

	unpair (id) {
		const before = this.store.devices.length;
		this.store.devices = this.store.devices.filter((d) => d.id !== id);
		this.#save();
		return this.store.devices.length !== before;
	}

	/** Показать QR для ещё одного телефона на 5 минут. */
	showQr () {
		this.pairCode = null;
		this.showQrUntil = Date.now() + 5 * 60000;
	}

	// ---------- что показать ----------

	studioUrl (withCode) {
		const host = this.link.ip || "localhost";
		const base = `http://${host}${this.studioPort === 80 ? "" : `:${this.studioPort}`}`;
		return withCode ? `${base}/pair?code=${this.pairingCode()}` : `${base}/`;
	}

	setupUrl () {
		const ip = this.net.apIp || "10.42.0.1";
		return this.captivePort === 80 ? `http://${ip}/setup` : `http://${ip}:${this.studioPort}/setup`;
	}

	wifiQrText () {
		const esc = (s) => String(s).replace(/([\\;,:"])/g, "\\$1");
		const ap = this.store.ap;
		return ap ? `WIFI:T:WPA;S:${esc(ap.ssid)};P:${esc(ap.password)};;` : "";
	}

	/** Для экрана зеркала (только с самого устройства: здесь пароль сети и код привязки). */
	screenState () {
		const needQr = this.phase === "online" && (this.store.devices.length === 0 || Date.now() < this.showQrUntil);
		return {
			phase: this.phase,
			lastError: this.lastError,
			connectingTo: this.connectingTo,
			network: { ssid: this.link.ssid, ip: this.link.ip, via: this.link.via, connected: this.link.connected, offline: this.phase === "online" && Boolean(this.offlineSince) },
			ap: this.phase === "setup" || this.phase === "connecting" ? { ...this.store.ap, setupUrl: this.setupUrl() } : null,
			studio: needQr ? { url: this.studioUrl(false), pairUrl: this.studioUrl(true) } : null,
			pairedDevices: this.store.devices.length,
			justPaired: Date.now() - this.pairedAt < 8000
		};
	}

	/** Для страницы настройки на телефоне. */
	setupState () {
		return {
			phase: this.phase,
			lastError: this.lastError,
			connectingTo: this.connectingTo,
			networks: this.networks,
			ssid: this.phase === "online" ? this.link.ssid : null,
			apSsid: this.store.ap?.ssid || null
		};
	}

	async rescan () {
		if (this.phase !== "setup") return this.networks;
		const fresh = await this.net.scan({ rescan: false }).catch(() => []);
		if (fresh.length) this.networks = fresh;
		return this.networks;
	}
}

module.exports = { Onboarding };

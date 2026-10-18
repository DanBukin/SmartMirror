"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");

/**
 * Управляет процессом MagicMirror²: запуск, перезапуск, журнал.
 * В контейнере это `node serveronly` (без экрана), на Raspberry Pi —
 * та же команда или Electron (`npm start`), см. MM_START_CMD.
 */
class Mirror {
	constructor ({ dir, port, address, command, env }) {
		this.dir = dir;
		this.port = port;
		this.address = address;
		this.command = command;
		this.env = env;
		this.child = null;
		this.state = "stopped"; // stopped | starting | running | error
		this.startedAt = null;
		this.lastError = null;
		this.logs = [];
	}

	#log (line) {
		for (const l of String(line).split("\n")) {
			if (!l.trim()) continue;
			this.logs.push(l);
			if (l.includes("Ready to go!")) this.readySeen = true;
			if (this.logs.length > 300) this.logs.shift();
		}
	}

	/** Если зеркало поднялось позже таймаута, замечаем это при следующем запросе статуса. */
	async refresh () {
		if (!this.child || this.state === "running" || this.state === "stopped") return;
		try {
			if ((await this.#request("/startup")) === 200) {
				this.state = "running";
				this.lastError = null;
				this.startedAt ??= new Date().toISOString();
			}
		} catch { /* ещё не готово */ }
	}

	status () {
		return {
			state: this.state,
			startedAt: this.startedAt,
			lastError: this.lastError,
			port: this.port,
			pid: this.child?.pid ?? null
		};
	}

	async start () {
		if (this.child) return;
		this.state = "starting";
		this.lastError = null;
		this.readySeen = false;
		const [cmd, ...args] = this.command;
		const child = spawn(cmd, args, { cwd: this.dir, env: { ...process.env, ...this.env }, stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		child.stdout.on("data", (d) => this.#log(d));
		child.stderr.on("data", (d) => this.#log(d));
		child.on("exit", (code, signal) => {
			if (this.child === child) {
				this.child = null;
				if (this.state !== "stopped") {
					this.state = "error";
					this.lastError = `MagicMirror² завершился (код ${code}, сигнал ${signal})`;
				}
			}
		});
		// первый запуск на Windows бывает долгим (антивирус проверяет node_modules)
		const ok = await this.#waitUntilUp(120000);
		if (this.child === child) {
			if (ok) {
				this.state = "running";
				this.startedAt = new Date().toISOString();
			} else {
				this.state = "error";
				this.lastError ??= "MagicMirror² долго не отвечает — загляните в журнал";
			}
		}
		return ok;
	}

	async stop () {
		const child = this.child;
		if (!child) return;
		this.state = "stopped";
		this.child = null;
		await new Promise((resolve) => {
			const t = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
			child.once("exit", () => { clearTimeout(t); resolve(); });
			child.kill("SIGTERM");
		});
	}

	async restart () {
		await this.stop();
		await this.#waitUntilDown(10000);
		const ok = await this.start();
		// клиенты, уже переподключившиеся к новому серверу, перезагрузятся сразу;
		// остальные — по reloadAfterServerRestart
		if (ok) this.#request("/reload").catch(() => {});
		return ok;
	}

	/**
	 * «localhost» на Windows может означать и 127.0.0.1, и ::1 — пробуем оба адреса.
	 */
	async #request (path) {
		const hosts = this.address === "localhost" ? ["127.0.0.1", "::1"] : [this.address];
		let lastErr;
		for (const host of hosts) {
			try {
				return await this.#requestHost(host, path);
			} catch (err) {
				lastErr = err;
			}
		}
		this.lastProbeError = `${hosts.join(", ")}:${this.port}${path} — ${lastErr?.message}`;
		throw lastErr;
	}

	#requestHost (host, path) {
		return new Promise((resolve, reject) => {
			const req = http.get({ host, port: this.port, path, timeout: 2000 }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error("timeout")));
		});
	}

	async #waitUntilUp (ms) {
		const until = Date.now() + ms;
		let readyAt = null;
		while (Date.now() < until) {
			if (!this.child) return false;
			if (this.readySeen) {
				readyAt ??= Date.now();
				if (Date.now() - readyAt > 5000) break;
			}
			try {
				const code = await this.#request("/startup");
				if (code === 200) return true;
				this.lastProbeError = `/startup ответил ${code}`;
			} catch { /* ещё не поднялся */ }
			await new Promise((r) => setTimeout(r, 300));
		}
		// MagicMirror² пишет «Ready to go» даже если порт так и не открылся, поэтому верим только сети
		this.#log(`[studio] Нет ответа от MagicMirror²: ${this.lastProbeError}`);
		this.lastError = `Нет связи с зеркалом на порту ${this.port}: ${this.lastProbeError}`;
		return false;
	}

	async #waitUntilDown (ms) {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			try {
				await this.#request("/startup");
			} catch {
				return;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	}
}

module.exports = { Mirror };

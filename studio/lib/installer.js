"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/([\w-]+?)(?:\.git)?\/?$/;

/**
 * Ставит сторонние модули MagicMirror² из GitHub:
 * git clone --depth 1 в MagicMirror/modules, затем npm install, если у модуля есть зависимости.
 */
class Installer {
	constructor (mmDir) {
		this.modulesDir = path.join(mmDir, "modules");
		this.busy = null;
	}

	isInstalled (name) {
		return Boolean(name) && fs.existsSync(path.join(this.modulesDir, name, `${name}.js`));
	}

	#run (cmd, args, cwd, log) {
		return new Promise((resolve, reject) => {
			// npm на Windows — это npm.cmd, его запускаем через оболочку; аргументы фиксированные
			const child = spawn(cmd, args, { cwd, shell: process.platform === "win32" && cmd === "npm", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
			child.stdout.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
			child.stderr.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
			child.on("error", (err) => reject(new Error(`${cmd}: ${err.message}`)));
			child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} завершился с кодом ${code}`))));
		});
	}

	/** @returns {Promise<{ok: boolean, module: string, log: string[], error?: string}>} */
	async install (repo) {
		const m = String(repo).match(REPO_RE);
		if (!m) return { ok: false, log: [], error: "Нужна ссылка вида https://github.com/автор/MMM-Модуль" };
		const name = m[1];
		if (this.isInstalled(name)) return { ok: true, module: name, log: ["Уже установлен"] };
		if (this.busy) return { ok: false, module: name, log: [], error: `Сейчас ставится ${this.busy}, подождите` };

		this.busy = name;
		const log = [];
		const target = path.join(this.modulesDir, name);
		try {
			if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); // остаток прошлой неудачной установки
			await this.#run("git", ["clone", "--depth", "1", `https://github.com/${repo.split("/")[3]}/${name}.git`, target], this.modulesDir, log);
			const pkgPath = path.join(target, "package.json");
			const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")) : {};
			if (Object.keys(pkg.dependencies || {}).length) {
				await this.#run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], target, log);
			}
			if (!this.isInstalled(name)) throw new Error(`В репозитории нет файла ${name}.js — это точно модуль MagicMirror²?`);
			return { ok: true, module: name, log };
		} catch (err) {
			return { ok: false, module: name, log, error: err.message };
		} finally {
			this.busy = null;
		}
	}
}

module.exports = { Installer };

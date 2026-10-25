"use strict";

// Настройка Wi‑Fi с телефона. Телефон подключён к сети зеркала SmartMirror-XXXX,
// выбирает домашнюю сеть, и зеркало переключается на неё. После этого связь с этой
// страницей пропадает — так и задумано: телефон возвращается в домашнюю сеть.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
	const node = Object.assign(document.createElement(tag), attrs);
	node.append(...children);
	return node;
};

let networks = [];
let chosen = null; // { ssid, secure, hidden }
let sentTo = null;

function bars (signal) {
	const n = signal > 75 ? 4 : signal > 50 ? 3 : signal > 25 ? 2 : 1;
	return el("span", { className: "bars", title: `Сигнал ${signal}%` }, ...[1, 2, 3, 4].map((i) => el("i", { className: i <= n ? "on" : "" })));
}

function renderNets () {
	const list = $("nets");
	if (!networks.length) {
		list.replaceChildren(el("li", { className: "empty", textContent: "Сети не найдены. Нажмите «Обновить» или введите сеть вручную." }));
		return;
	}
	list.replaceChildren(...networks.map((n) => el("li", {},
		el("button", { type: "button", onclick: () => choose(n), ariaPressed: String(chosen?.ssid === n.ssid && !chosen.hidden) },
			bars(n.signal), el("span", { className: "name", textContent: n.ssid }), el("span", { className: "lock", textContent: n.secure ? "🔒" : "открытая" })))));
}

function choose (n) {
	chosen = n;
	$("join").hidden = false;
	$("ssidField").hidden = !n.hidden;
	$("passField").hidden = !n.secure;
	$("joinName").textContent = n.hidden ? "сети" : n.ssid;
	$("password").value = "";
	renderNets();
	(n.hidden ? $("ssid") : n.secure ? $("password") : $("connectBtn")).focus();
	$("join").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showError (msg) {
	$("error").hidden = !msg;
	$("error").textContent = msg || "";
}

function showSection (id) {
	for (const s of ["choose", "waiting", "done"]) $(s).hidden = s !== id;
}

function setSsidName (name) {
	document.querySelectorAll(".ssidName").forEach((n) => { n.textContent = name; });
}

async function api (method, path, body) {
	const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body), cache: "no-store" });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || r.statusText);
	return data;
}

function apply (s) {
	if (s.networks) {
		networks = s.networks;
		renderNets();
	}
	if (s.phase === "connecting") {
		setSsidName(s.connectingTo);
		showSection("waiting");
	} else if (s.phase === "online") {
		setSsidName(s.ssid || sentTo || "");
		showSection("done");
	} else {
		// setup: первый заход или неудачная попытка (телефон вернулся в сеть зеркала)
		showSection("choose");
		showError(s.lastError);
	}
}

async function connect (e) {
	e.preventDefault();
	const ssid = chosen.hidden ? $("ssid").value.trim() : chosen.ssid;
	const password = chosen.secure ? $("password").value : "";
	if (!ssid) return showError("Введите название сети");
	if (chosen.secure && password.length < 8) return showError("Пароль Wi‑Fi — не короче 8 символов");
	showError(null);
	$("connectBtn").disabled = true;
	try {
		sentTo = ssid;
		apply(await api("POST", "/api/onboarding/connect", { ssid, password, hidden: Boolean(chosen.hidden) }));
	} catch (err) {
		showError(err.message);
	} finally {
		$("connectBtn").disabled = false;
	}
}

async function poll () {
	try {
		apply(await api("GET", "/api/onboarding/setup"));
	} catch {
		// связи с зеркалом нет: оно переключается на домашний Wi‑Fi — экран «ждём» остаётся
	}
	setTimeout(poll, 2000);
}

$("join").addEventListener("submit", connect);
$("otherBtn").addEventListener("click", () => choose({ ssid: "", secure: true, hidden: true }));
$("togglePass").addEventListener("click", () => {
	const p = $("password");
	p.type = p.type === "password" ? "text" : "password";
});
$("rescan").addEventListener("click", async () => {
	$("rescan").disabled = true;
	try {
		networks = (await api("POST", "/api/onboarding/rescan")).networks;
		renderNets();
	} catch (err) {
		showError(err.message);
	} finally {
		$("rescan").disabled = false;
	}
});

poll();

"use strict";

// Экран зеркала. Раз в секунду спрашивает у Studio, что показывать:
// booting — запуск, setup — QR для подключения телефона к сети зеркала,
// connecting — подключение к домашнему Wi‑Fi, online — MagicMirror² (+ QR для Studio).

const $ = (id) => document.getElementById(id);
let mirrorSrc = null;
let pairedShown = false;

const mirrorHost = () => (["localhost", "::1", "[::1]"].includes(location.hostname) ? "127.0.0.1" : location.hostname);

function show (id) {
	for (const s of ["booting", "setup", "connecting"]) $(s).hidden = s !== id;
}

function setQr (img, kind, key) {
	// перерисовываем картинку, только когда меняется то, что в ней зашито
	if (img.dataset.key !== key) {
		img.dataset.key = key;
		img.src = `/api/onboarding/qr/${kind}.svg?k=${encodeURIComponent(key)}`;
	}
}

function render (s) {
	const online = s.phase === "online";
	const mirrorReady = online && s.mirrorState === "running";

	if (s.phase === "booting" || (online && !mirrorReady)) {
		show("booting");
		$("bootText").textContent = online ? "Запускаю MagicMirror²…" : "Запускаюсь…";
	} else if (s.phase === "setup") {
		show("setup");
		$("setupError").hidden = !s.lastError;
		$("setupError").textContent = s.lastError ? `Не получилось подключиться. ${s.lastError}` : "";
		$("apSsid").textContent = s.ap.ssid;
		$("apPassword").textContent = s.ap.password;
		$("setupUrl").textContent = s.ap.setupUrl.replace(/^http:\/\//, "");
		setQr($("wifiQr"), "wifi", `${s.ap.ssid}|${s.ap.password}`);
		setQr($("setupQr"), "setup", s.ap.setupUrl);
	} else if (s.phase === "connecting") {
		show("connecting");
		$("connectingTo").textContent = s.connectingTo;
	} else show(null);

	// MagicMirror² — после подключения к сети. Перезагружаем, если зеркало перезапустилось на другом порту.
	const src = mirrorReady ? `${location.protocol}//${mirrorHost()}:${s.mirrorPort}/` : null;
	if (src && src !== mirrorSrc) {
		mirrorSrc = src;
		$("mirror").src = src;
	}
	$("mirror").hidden = !mirrorReady;

	$("studioCard").hidden = !(mirrorReady && s.studio);
	if (mirrorReady && s.studio) {
		setQr($("studioQr"), "studio", s.studio.pairUrl);
		$("studioHint").textContent = s.network.ssid
			? `Отсканируйте код. Телефон должен быть в сети «${s.network.ssid}».`
			: "Отсканируйте код. Телефон должен быть в той же сети, что и зеркало.";
		$("studioUrl").textContent = s.studio.url.replace(/^http:\/\//, "");
	}

	$("offline").hidden = !(online && s.network.offline);

	if (s.justPaired && !pairedShown) {
		pairedShown = true;
		const t = $("paired");
		t.hidden = false;
		t.style.animation = "none";
		void t.offsetWidth; // перезапуск анимации
		t.style.animation = "";
		setTimeout(() => { t.hidden = true; pairedShown = false; }, 8000);
	}
	document.body.dataset.phase = s.phase;
}

async function poll () {
	try {
		const r = await fetch("/api/onboarding/screen", { cache: "no-store" });
		if (r.ok) render(await r.json());
	} catch {
		// Studio перезапускается — оставляем то, что уже на экране
	}
	setTimeout(poll, 1000);
}

poll();

"use strict";

const qrcode = require("./vendor/qrcode");

qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

/** QR-код как SVG. Чёрный на белом: инвертированные коды читают не все камеры. */
function qrSvg (text, { dark = "#000", light = "#fff" } = {}) {
	const qr = qrcode(0, "M");
	qr.addData(String(text));
	qr.make();
	const n = qr.getModuleCount();
	const m = 2; // поле вокруг кода, в модулях
	let d = "";
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
	}
	const size = n + m * 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { qrSvg };

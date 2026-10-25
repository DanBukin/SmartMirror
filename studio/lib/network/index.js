"use strict";

const { NmcliNetwork } = require("./nmcli");
const { MockNetwork } = require("./mock");

/**
 * NET_BACKEND=nmcli — настоящий Wi‑Fi на Raspberry Pi (NetworkManager);
 * NET_BACKEND=mock — виртуальный Wi‑Fi для разработки и проверок;
 * без NET_BACKEND сетью Studio не управляет (как раньше).
 */
function createNetwork (backend, { dataDir }) {
	if (backend === "nmcli") return new NmcliNetwork();
	if (backend === "mock") return new MockNetwork({ file: `${dataDir}/mock-wifi.json` });
	return null;
}

module.exports = { createNetwork };

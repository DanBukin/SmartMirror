/* Загружает официальные курсы ЦБ РФ (cbr-xml-daily.ru, без ключа) на стороне сервера. */
const NodeHelper = require("node_helper");
const Log = require("logger");

module.exports = NodeHelper.create({
	start () {
		this.timers = {};
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "CBR_START") return;
		const { id, url, interval } = payload;
		clearInterval(this.timers[id]);
		const load = async () => {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				this.sendSocketNotification("CBR_DATA", { id, date: data.Date, rates: data.Valute });
			} catch (err) {
				Log.error(`[MMM-CBRRates] ${err.message}`);
				this.sendSocketNotification("CBR_ERROR", { id, message: err.message });
			}
		};
		load();
		this.timers[id] = setInterval(load, interval);
	}
});

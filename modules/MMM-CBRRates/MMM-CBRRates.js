/* MMM-CBRRates — курсы валют ЦБ РФ на сегодня с изменением к прошлому дню. */
Module.register("MMM-CBRRates", {
	defaults: {
		currencies: ["USD", "EUR", "CNY"],
		showChange: true,
		url: "https://www.cbr-xml-daily.ru/daily_json.js",
		updateInterval: 60 * 60 * 1000
	},

	SYMBOLS: { USD: "$", EUR: "€", CNY: "¥", GBP: "£", JPY: "¥", TRY: "₺", KZT: "₸", BYN: "Br", CHF: "₣", AED: "د.إ" },

	getStyles () {
		return ["MMM-CBRRates.css"];
	},

	start () {
		this.rates = null;
		this.error = null;
		this.sendSocketNotification("CBR_START", { id: this.identifier, url: this.config.url, interval: this.config.updateInterval });
	},

	socketNotificationReceived (notification, payload) {
		if (payload.id !== this.identifier) return;
		if (notification === "CBR_DATA") {
			this.rates = payload.rates;
			this.date = payload.date;
			this.error = null;
		} else if (notification === "CBR_ERROR") {
			this.error = payload.message;
		}
		this.updateDom(500);
	},

	getDom () {
		const box = document.createElement("div");
		box.className = "cbr-rates small";
		if (!this.rates) {
			box.innerHTML = `<span class="dimmed">${this.error ? "Нет связи с ЦБ" : "Загрузка курсов…"}</span>`;
			return box;
		}
		const table = document.createElement("table");
		for (const code of this.config.currencies) {
			const r = this.rates[code];
			if (!r) continue;
			const value = r.Value / r.Nominal;
			const diff = (r.Value - r.Previous) / r.Nominal;
			const row = document.createElement("tr");
			const sign = diff > 0 ? "▲" : diff < 0 ? "▼" : "";
			row.innerHTML = `
				<td class="symbol">${this.SYMBOLS[code] || ""}</td>
				<td class="code dimmed">${code}</td>
				<td class="value bright">${value.toFixed(2)} ₽</td>
				${this.config.showChange ? `<td class="change ${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${sign} ${Math.abs(diff).toFixed(2)}</td>` : ""}`;
			table.appendChild(row);
		}
		box.appendChild(table);
		if (this.date) {
			const d = document.createElement("div");
			d.className = "xsmall dimmed";
			d.textContent = `ЦБ РФ, ${new Date(this.date).toLocaleDateString("ru-RU")}`;
			box.appendChild(d);
		}
		return box;
	}
});

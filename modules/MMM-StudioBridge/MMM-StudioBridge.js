/* global Module */

/*
 * MMM-StudioBridge — служебный модуль SmartMirror Studio.
 * Когда зеркало открыто внутри приложения (во фрейме), сообщает ему, где на экране
 * стоит каждый виджет и какого он размера. На настоящем зеркале ничего не делает.
 */
Module.register("MMM-StudioBridge", {
	start () {
		if (window.parent === window) return;
		setInterval(() => this.report(), 1500);
	},

	notificationReceived (notification) {
		if (notification === "DOM_OBJECTS_CREATED" || notification === "MODULE_DOM_UPDATED") this.report();
	},

	report () {
		if (window.parent === window) return;
		const width = window.innerWidth;
		const height = window.innerHeight;
		const rects = {};
		for (const node of document.querySelectorAll(".module")) {
			const cls = [...node.classList].find((c) => c.startsWith("sm-"));
			if (!cls) continue;
			const r = node.getBoundingClientRect();
			if (!r.width || !r.height) continue;
			rects[cls.slice(3)] = { x: r.left / width, y: r.top / height, w: r.width / width, h: r.height / height };
		}
		window.parent.postMessage({ type: "smartmirror:rects", width, height, rects }, "*");
	}
});

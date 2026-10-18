/* MMM-SimpleTodo — простой список задач для SmartMirror.
 * Задачи задаются в config.items; строка с префиксом "[x] " считается выполненной.
 */
Module.register("MMM-SimpleTodo", {
	defaults: {
		items: [],
		hideDone: false
	},

	getStyles () {
		return ["MMM-SimpleTodo.css"];
	},

	getDom () {
		const list = document.createElement("ul");
		list.className = "simple-todo small";
		const items = this.config.items
			.map((raw) => {
				const done = /^\[x\]\s*/i.test(raw);
				return { done, text: raw.replace(/^\[[x ]\]\s*/i, "") };
			})
			.filter((item) => !(item.done && this.config.hideDone));

		if (items.length === 0) {
			list.innerHTML = "<li class=\"dimmed\">Задач нет</li>";
			return list;
		}
		for (const item of items) {
			const li = document.createElement("li");
			li.className = item.done ? "done dimmed" : "bright";
			const icon = document.createElement("i");
			icon.className = item.done ? "fa-regular fa-square-check" : "fa-regular fa-square";
			const text = document.createElement("span");
			text.textContent = item.text;
			li.append(icon, text);
			list.appendChild(li);
		}
		return list;
	}
});

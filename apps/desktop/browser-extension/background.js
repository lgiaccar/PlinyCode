let socket, heartbeat;
let connected = false;
const shared = new Map();
const queues = new Map();
function disconnect() {
	connected = false;
	clearInterval(heartbeat);
	socket?.close();
	socket = undefined;
	shared.clear();
}
chrome.tabs.onRemoved.addListener((id) => shared.delete(id));
chrome.tabs.onUpdated.addListener((id, change) => {
	if (
		change.url &&
		shared.has(id) &&
		new URL(change.url).origin !== shared.get(id)
	)
		shared.delete(id);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
	if (
		sender.id !== chrome.runtime.id ||
		sender.url !== chrome.runtime.getURL("popup.html")
	)
		return;
	void (async () => {
		switch (message.type) {
			case "connect": {
				if (
					!/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/.test(message.address) ||
					!/^[a-f0-9]{64}$/.test(message.token)
				)
					throw new Error(
						"Copy the address and token from PlinyCode Desktop Settings.",
					);
				disconnect();
				const peer = new WebSocket(message.address);
				socket = peer;
				peer.onopen = () =>
					peer.send(JSON.stringify({ type: "hello", token: message.token }));
				peer.onclose = () => {
					if (socket === peer) disconnect();
				};
				peer.onmessage = ({ data }) => {
					const event = JSON.parse(data);
					if (event.type === "ready") {
						connected = true;
						heartbeat = setInterval(() => peer.send('{"type":"ping"}'), 20_000);
					}
					if (event.type === "action") {
						const key = event.action.tabId ?? "tabs";
						const operation = (queues.get(key) ?? Promise.resolve())
							.catch(() => {})
							.then(async () => {
								if (socket !== peer || !connected)
									throw new Error("Disconnected.");
								return perform(event.action);
							});
						queues.set(key, operation);
						void operation
							.then(
								(value) =>
									peer.readyState === 1 &&
									peer.send(
										JSON.stringify({ type: "result", id: event.id, value }),
									),
								(error) =>
									peer.readyState === 1 &&
									peer.send(
										JSON.stringify({
											type: "result",
											id: event.id,
											error: String(error.message),
										}),
									),
							)
							.finally(() => {
								if (queues.get(key) === operation) queues.delete(key);
							});
					}
				};
				return { status: "Connecting; refresh the popup to check status." };
			}
			case "disconnect":
				disconnect();
				break;
			case "share": {
				if (!connected) throw new Error("Connect to Desktop first.");
				const tab = await chrome.tabs.get(message.tabId);
				if (!/^https?:/.test(tab.url))
					throw new Error("Only HTTP and HTTPS tabs can be shared.");
				await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					func: () => true,
				});
				shared.set(tab.id, new URL(tab.url).origin);
				break;
			}
			case "revoke":
				shared.delete(message.tabId);
				break;
		}
		return {
			status: `${connected ? "Connected" : "Disconnected"}; ${shared.size} shared tab(s).`,
		};
	})().then(reply, (error) => reply({ error: String(error.message) }));
	return true;
});
async function perform(action) {
	if (action.operation === "tabs") {
		const tabs = await chrome.tabs.query({});
		return tabs
			.filter((tab) => shared.has(tab.id))
			.map(({ id, title, url }) => ({ id, title, url }));
	}
	const tab = await chrome.tabs.get(action.tabId);
	if (!shared.has(tab.id) || new URL(tab.url).origin !== shared.get(tab.id))
		throw new Error("Share this tab from the PlinyCode extension popup first.");
	if (action.operation === "navigate") {
		const destination = new URL(action.url);
		if (
			!/^https?:$/.test(destination.protocol) ||
			destination.origin !== shared.get(tab.id) ||
			destination.username ||
			destination.password
		)
			throw new Error(
				"Navigation is limited to the shared origin. Open and share another origin manually.",
			);
		await chrome.tabs.update(tab.id, { url: destination.href });
		return "Navigation started. Take a fresh snapshot after the page loads.";
	}
	const [result] = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: interact,
		args: [action, shared.get(tab.id)],
	});
	if (result?.result?.plinyError) throw new Error(result.result.plinyError);
	if (result?.result === undefined)
		throw new Error(
			"The page action returned no result. Inspect the tab before retrying.",
		);
	return result.result;
}
// Runs in Chrome's isolated world. References are invalidated on every snapshot.
function interact(action, origin) {
	try {
		if (location.origin !== origin)
			throw new Error(
				"The tab changed origin; share it again before continuing.",
			);
		if (action.operation === "snapshot") {
			const elements = [
				...document.querySelectorAll(
					"a,button,input,textarea,select,[role=button],[contenteditable=true]",
				),
			]
				.filter((element) => element.getClientRects().length)
				.slice(0, 500);
			const offset = globalThis.plinyNextRef ?? 0;
			globalThis.plinyNextRef = offset + elements.length;
			globalThis.plinyElements = new Map(
				elements.map((element, index) => [offset + index + 1, element]),
			);
			return {
				title: document.title,
				url: location.href,
				text: document.body.innerText.slice(0, 40_000),
				elements: elements.map((element, index) => ({
					ref: offset + index + 1,
					tag: element.tagName,
					label: (
						element.getAttribute("aria-label") ||
						element.getAttribute("placeholder") ||
						element.textContent ||
						""
					).slice(0, 250),
					type: element.getAttribute("type"),
				})),
			};
		}
		const element = globalThis.plinyElements?.get(action.ref);
		if (!element?.isConnected || !element.getClientRects().length)
			throw new Error(
				"Take a fresh snapshot and use a visible element reference.",
			);
		if (action.operation === "click") {
			element.click();
			return "Clicked. Take a fresh snapshot to inspect the result.";
		}
		if (action.operation === "fill") {
			if (typeof action.text !== "string") throw new Error("text is required.");
			if (
				element instanceof HTMLInputElement &&
				["file", "password"].includes(element.type)
			)
				throw new Error("Enter passwords and choose files manually.");
			const prototype =
				element instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: element instanceof HTMLSelectElement
						? HTMLSelectElement.prototype
						: element instanceof HTMLInputElement
							? HTMLInputElement.prototype
							: undefined;
			if (prototype)
				Object.getOwnPropertyDescriptor(prototype, "value").set.call(
					element,
					action.text,
				);
			else if (element.isContentEditable) element.textContent = action.text;
			else throw new Error("The referenced element is not editable.");
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
			return "Filled.";
		}
		throw new Error("Unsupported browser operation.");
	} catch (error) {
		return { plinyError: String(error.message) };
	}
}

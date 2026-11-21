document.getElementById("identity").textContent =
	`Extension ID: ${chrome.runtime.id}`;
async function send(message) {
	const result = await chrome.runtime.sendMessage(message);
	document.getElementById("status").textContent = result.error || result.status;
}
document.getElementById("connect").onclick = () =>
	send({
		type: "connect",
		address: document.getElementById("address").value.trim(),
		token: document.getElementById("token").value.trim(),
	});
document.getElementById("disconnect").onclick = () =>
	send({ type: "disconnect" });
for (const type of ["share", "revoke"])
	document.getElementById(type).onclick = async () => {
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
		await send({ type, tabId: tab.id });
	};
void send({ type: "status" });

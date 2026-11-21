/** Real companion extension in an isolated Chromium profile; no user browser is touched. */
import { strict as assert } from "node:assert";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(root, "../../ai_output");
await mkdir(scratch, { recursive: true });
const data = await mkdtemp(join(scratch, "desktop-browser-e2e-"));
const server = createServer((request, response) => {
	response.setHeader("Content-Type", "text/html");
	response.end(
		`<title>Browser fixture</title><h1>${request.headers.cookie?.includes("session=signed-in") ? "Signed-in fixture" : "Anonymous"}</h1><input aria-label="Report name"><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save report</button><output></output>`,
	);
});
await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
const address = server.address();
if (!address || typeof address === "string")
	throw new Error("Fixture did not start");
const origin = `http://127.0.0.1:${address.port}`;
const extension = join(data, "extension");
await cp(join(root, "browser-extension"), extension, { recursive: true });
const manifest = JSON.parse(
	await readFile(join(extension, "manifest.json"), "utf8"),
);
// Test-only host grant substitutes for Chrome's toolbar activeTab gesture, which
// Playwright cannot trigger. The shipped manifest has no such host grant.
manifest.host_permissions = [`${origin}/*`];
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
const { BrowserBridge } = createRequire(import.meta.url)(
	join(scratch, "browser-fixture.cjs"),
) as typeof import("../src/browser");
let bridge: InstanceType<typeof BrowserBridge> | undefined;
const context = await chromium.launchPersistentContext(join(data, "profile"), {
	channel: "chromium",
	headless: false,
	args: [
		`--disable-extensions-except=${extension}`,
		`--load-extension=${extension}`,
	],
});
try {
	await context.addCookies([
		{ name: "session", value: "signed-in", url: origin, httpOnly: true },
	]);
	const page = await context.newPage();
	await page.goto(origin);
	const worker =
		context.serviceWorkers()[0] ??
		(await context.waitForEvent("serviceworker"));
	const id = new URL(worker.url()).host;
	bridge = new BrowserBridge(id);
	const pairing = await bridge.start();
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${id}/popup.html`);
	await popup.getByLabel("Desktop address").fill(pairing.address as string);
	await popup.getByLabel("Pairing token").fill(pairing.token as string);
	await popup.getByRole("button", { name: "Connect", exact: true }).click();
	await popup.waitForFunction(async () =>
		(
			await (
				globalThis as unknown as {
					chrome: {
						runtime: {
							sendMessage: (message: unknown) => Promise<{ status: string }>;
						};
					};
				}
			).chrome.runtime.sendMessage({ type: "status" })
		).status.startsWith("Connected"),
	);
	const tabId = await popup.evaluate(async (origin) => {
		const chrome = (
			globalThis as unknown as {
				chrome: {
					tabs: {
						query: (input: unknown) => Promise<{ id: number; url: string }[]>;
					};
					runtime: {
						sendMessage: (input: unknown) => Promise<{ error?: string }>;
					};
				};
			}
		).chrome;
		const tab = (await chrome.tabs.query({})).find((tab) =>
			tab.url.startsWith(origin),
		);
		if (!tab) throw new Error("Fixture tab missing");
		const result = await chrome.runtime.sendMessage({
			type: "share",
			tabId: tab.id,
		});
		if (result.error) throw new Error(result.error);
		return tab.id;
	}, origin);
	assert.equal(bridge.status().connected, true);
	const tabs = (await bridge.request("task", { operation: "tabs" })) as {
		id: number;
	}[];
	assert.equal(tabs.length, 1);
	assert.equal(tabs[0].id, tabId);
	const snapshot = (await bridge.request("task", {
		operation: "snapshot",
		tabId,
	})) as { text: string; elements: { ref: number; label: string }[] };
	assert.match(snapshot.text, /Signed-in fixture/);
	const input = snapshot.elements.find((item) => item.label === "Report name"),
		button = snapshot.elements.find((item) => item.label === "Save report");
	assert.ok(input && button);
	await bridge.request("task", {
		operation: "fill",
		tabId,
		ref: input.ref,
		text: "PlinyCode browser report",
	});
	await bridge.request("task", { operation: "click", tabId, ref: button.ref });
	assert.equal(
		await page.locator("output").textContent(),
		"PlinyCode browser report",
	);
	await bridge.request("task", { operation: "snapshot", tabId });
	await assert.rejects(
		bridge.request("task", { operation: "click", tabId, ref: button.ref }),
		/fresh snapshot/,
	);
	await assert.rejects(
		bridge.request("other", { operation: "snapshot", tabId }),
		/another task/,
	);
	await assert.rejects(
		bridge.request("task", {
			operation: "navigate",
			tabId,
			url: "https://example.invalid",
		}),
		/shared origin/,
	);
	await bridge.request("task", {
		operation: "navigate",
		tabId,
		url: `${origin}/next`,
	});
	await page.waitForURL(`${origin}/next`);
	assert.match(
		(
			(await bridge.request("task", { operation: "snapshot", tabId })) as {
				text: string;
			}
		).text,
		/Signed-in fixture/,
	);
	await popup.close();
	// Survive Chrome's 30-second service-worker idle window using the heartbeat.
	await new Promise((accept) => setTimeout(accept, 35_000));
	assert.equal(bridge.status().connected, true);
	await page.screenshot({ path: join(data, "browser.png") });
	await bridge.close();
	bridge = undefined;
	assert.equal(
		page.isClosed(),
		false,
		"Disconnect must leave the user's tab open",
	);
	console.log(
		`PASS: signed-in session, selected tabs, DOM actions, leases, navigation guard, heartbeat and disconnect. Evidence: ${data}`,
	);
} finally {
	await bridge?.close();
	await context.close();
	server.closeAllConnections();
	await new Promise<void>((accept) => server.close(() => accept()));
}

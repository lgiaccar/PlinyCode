import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { Task } from "../src/contracts";
import type { TaskManager } from "../src/manager";
import type { SecretVault } from "../src/vault";

const { Integrations } = createRequire(import.meta.url)(
	"../../../ai_output/integrations-fixture.cjs",
) as typeof import("../src/integrations");

const { BrowserBridge } = createRequire(import.meta.url)(
	"../../../ai_output/browser-fixture.cjs",
) as typeof import("../src/browser");
const extensionId = "a".repeat(32);
test("PR publishing cannot overlap an existing restart or other task operation", async () => {
	const task = { id: "fixture", status: "completed" } as Task;
	const manager = {
		external: new Set([task.id]),
		running: new Map(),
		store: { state: { commands: [] } },
		project: () => {
			throw new Error(
				"PR validation must not begin while restart holds the task",
			);
		},
	} as unknown as TaskManager;
	const integrations = new Integrations(manager, {} as SecretVault);
	await assert.rejects(
		integrations.create(task, {
			title: "Fixture",
			body: "",
			target: "main",
			draft: true,
			commit: false,
			retryUncertain: false,
		}),
		/Stop this task|pending task/,
	);
	assert.equal(
		manager.external.has(task.id),
		true,
		"The other operation must retain its lock",
	);
});
test("concurrent pairing, disconnect and shutdown do not leave orphan bridge listeners", {
	timeout: 5000,
}, async () => {
	const integrations = new Integrations({} as TaskManager, {} as SecretVault);
	try {
		const [first, second] = await Promise.all([
			integrations.pair(extensionId),
			integrations.pair(extensionId),
		]);
		await assert.rejects(
			connect(first.address as string, first.token as string),
		);
		const peer = await connect(
			second.address as string,
			second.token as string,
		);
		const pending = integrations.pair(extensionId);
		const disconnected = integrations.disconnectBrowser();
		const third = await pending;
		await disconnected;
		assert.equal(integrations.browser, undefined);
		await assert.rejects(
			connect(third.address as string, third.token as string),
		);
		peer.terminate();
		const closingPair = integrations.pair(extensionId);
		const closing = integrations.close();
		await assert.rejects(closingPair, /closing/);
		await closing;
	} finally {
		await integrations.close();
	}
});
async function connect(
	address: string,
	token: string,
	origin = `chrome-extension://${extensionId}`,
) {
	const peer = new WebSocket(address, { origin });
	peer.on("error", () => {});
	await new Promise<void>((accept, reject) => {
		peer.once("open", accept);
		peer.once("error", reject);
	});
	const ready = new Promise<void>((accept, reject) => {
		peer.once("message", () => accept());
		peer.once("close", () => reject(new Error("Rejected")));
	});
	peer.send(JSON.stringify({ type: "hello", token }));
	await ready;
	return peer;
}
test("browser authentication, tab leases and disconnect", {
	timeout: 5000,
}, async () => {
	const bridge = new BrowserBridge(extensionId, 500);
	const pairing = await bridge.start();
	try {
		await assert.rejects(
			connect(
				pairing.address as string,
				pairing.token as string,
				"https://evil.invalid",
			),
		);
		await assert.rejects(
			connect(pairing.address as string, "b".repeat(64)),
			/Rejected/,
		);
		const peer = await connect(
			pairing.address as string,
			pairing.token as string,
		);
		peer.on("message", (raw) => {
			const request = JSON.parse(raw.toString());
			if (request.type === "action")
				peer.send(
					JSON.stringify({
						type: "result",
						id: request.id,
						value: "signed-in fixture",
					}),
				);
		});
		assert.equal(bridge.status().connected, true);
		assert.equal("token" in bridge.status(), false);
		assert.equal(
			await bridge.request("task-a", { operation: "snapshot", tabId: 4 }),
			"signed-in fixture",
		);
		await assert.rejects(
			bridge.request("task-b", { operation: "click", tabId: 4, ref: 1 }),
			/another task/,
		);
		bridge.release("task-a");
		await bridge.request("task-b", { operation: "snapshot", tabId: 4 });
		const closed = new Promise<void>((accept) => peer.once("close", accept));
		peer.close();
		await closed;
		await assert.rejects(
			bridge.request("task-b", { operation: "tabs" }),
			/Connect/,
		);
	} finally {
		await bridge.close();
	}
});
test("browser actions time out and cancel without automatic retry", {
	timeout: 5000,
}, async () => {
	const bridge = new BrowserBridge(extensionId, 80);
	const pairing = await bridge.start();
	try {
		const peer = await connect(
			pairing.address as string,
			pairing.token as string,
		);
		let calls = 0;
		peer.on("message", () => calls++);
		await assert.rejects(
			bridge.request("task", { operation: "click", tabId: 5, ref: 1 }),
			/timed out/,
		);
		const controller = new AbortController();
		const operation = bridge.request(
			"task",
			{ operation: "snapshot", tabId: 5 },
			controller.signal,
		);
		controller.abort();
		await assert.rejects(operation, /interrupted/);
		await new Promise((accept) => setTimeout(accept, 10));
		assert.equal(calls, 2);
		peer.terminate();
	} finally {
		await bridge.close();
	}
});

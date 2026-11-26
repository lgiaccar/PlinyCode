/** Real Electron + bundled Bun worker, local gateway only. No live credentials. */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron, type Page } from "playwright";
import { WebSocket } from "ws";

// Wait for the new turn to render before checking status: the previous turn may
// still show "completed" while React is awaiting the send IPC response.
async function sendPrompt(page: Page) {
	const before = await page.locator(".message.user").count();
	await page.getByRole("button", { name: /^Send/ }).click();
	await page.waitForFunction(
		(count) => document.querySelectorAll(".message.user").length === count + 1,
		before,
	);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(root, "../../ai_output");
await mkdir(scratch, { recursive: true });
const data = await mkdtemp(join(scratch, "desktop-e2e-"));
const folder = join(data, "project");
await mkdir(folder);
const secret = "desktop-fixture-secret";
const requests: Array<Record<string, unknown>> = [];
let reply: string | { name: string; input: unknown } = "Desktop is ready.";
let hang = false;
let improvedReply = "Please fix the failing tests.";
let waitForRewrite: Promise<void> | undefined;
let mcpCalls = 0;
let fixtureToolName = "echo";
const server = createServer(async (request, output) => {
	if (request.url?.startsWith("/collection/")) {
		assert.equal(
			request.method,
			"GET",
			"UI fixture must not publish a real PR",
		);
		assert.equal(
			request.headers.authorization,
			`Basic ${Buffer.from(":provider-fixture-secret").toString("base64")}`,
		);
		assert.ok(request.url.includes("api-version=6.0"));
		output.writeHead(200, { "content-type": "application/json" });
		output.end('{"value":[]}');
		return;
	}
	if (request.url === "/mcp" && request.method !== "POST") {
		output.writeHead(405);
		output.end();
		return;
	}
	let input = "";
	for await (const chunk of request) input += chunk.toString();
	const body = JSON.parse(input) as Record<string, unknown>;
	if (request.url === "/mcp") {
		if (request.headers.authorization !== "Bearer mcp-fixture-token") {
			output.writeHead(401);
			output.end();
			return;
		}
		if (body.id === undefined) {
			output.writeHead(202);
			output.end();
			return;
		}
		const params = body.params as {
			protocolVersion?: string;
			arguments?: { value?: string };
		};
		if (body.method === "tools/call") mcpCalls++;
		const result =
			body.method === "initialize"
				? {
						protocolVersion: params.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					}
				: body.method === "tools/list"
					? {
							tools: [
								{
									name: fixtureToolName,
									description: "Echo value",
									inputSchema: {
										type: "object",
										properties: { value: { type: "string" } },
									},
								},
							],
						}
					: body.method === "tools/call"
						? { content: [{ type: "text", text: params.arguments?.value }] }
						: {};
		output.writeHead(200, { "content-type": "application/json" });
		output.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
		return;
	}
	const suggestionRequest = JSON.stringify(body.messages).includes(
		"Suggest the single most useful next message",
	);
	if (!suggestionRequest) requests.push(body);
	const utility =
		body.model === "snps-provider/qwen3-next-80b-a3b-instruct-d79b4";
	if (utility && !suggestionRequest && waitForRewrite) await waitForRewrite;
	output.writeHead(200, { "content-type": "text/event-stream" });
	if (hang) {
		output.write(": wait\n\n");
		return;
	}
	const value = suggestionRequest
		? "Add tests for the remaining edge cases."
		: utility
			? improvedReply
			: reply;
	if (!utility) reply = "Done.";
	const deltas =
		typeof value === "string"
			? [...value].map((content) => ({ content }))
			: [
					{
						tool_calls: [
							{
								index: 0,
								id: "test-call",
								type: "function",
								function: {
									name: value.name,
									arguments: JSON.stringify(value.input),
								},
							},
						],
					},
				];
	let response = "";
	for (const delta of [...deltas, {}])
		response += `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : typeof value === "string" ? "stop" : "tool_calls" }] })}\n\n`;
	output.end(`${response}data: [DONE]\n\n`);
});
await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
const address = server.address();
if (!address || typeof address === "string")
	throw new Error("No fixture port.");
const env: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([, value]) => value !== undefined),
	),
	PLINY_DESKTOP_DATA: join(data, "state"),
	PLINY_DESKTOP_TEST_PROJECT: folder,
	PLINY_API_KEY: secret,
	PLINY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
};
delete env.ELECTRON_RUN_AS_NODE;
env.GIT_CEILING_DIRECTORIES = data;
const packaged = process.env.PLINY_DESKTOP_EXECUTABLE;
const electron =
	packaged ?? (createRequire(import.meta.url)("electron") as string);
const launch = () =>
	_electron.launch({
		executablePath: electron,
		args: [
			...(packaged ? [] : [root]),
			`--user-data-dir=${join(data, "electron-profile")}`,
		],
		env,
		timeout: 40_000,
	});
let application = await launch().catch((error) => {
	server.closeAllConnections();
	server.close();
	throw error;
});
try {
	if (process.platform === "linux") {
		const storage = await application.evaluate(({ app, safeStorage }) => ({
			packaged: app.isPackaged,
			available: safeStorage.isEncryptionAvailable(),
			backend: safeStorage.getSelectedStorageBackend(),
		}));
		assert.equal(storage.available, true);
		assert.equal(storage.backend, "gnome_libsecret");
		assert.equal(storage.packaged, !!packaged);
		console.log("PASS: Linux GNOME keyring and expected application packaging");
	}
	let page = await application.firstWindow();
	page.on("pageerror", (error) => console.error("renderer", error.message));
	page.on("console", (message) =>
		console.log("renderer console", message.text()),
	);
	if (!process.env.PLINY_DESKTOP_E2E_PR_ONLY) {
		await page.getByRole("button", { name: "Choose a project folder" }).click();
		await page.getByRole("textbox", { name: "Message PlinyCode" }).waitFor();
		const ordinary = await page.evaluate(
			async () => (await window.plinycode.invoke({ type: "snapshot" })).state,
		);
		assert.equal(ordinary.projects[0].git, false);
		assert.equal(ordinary.tasks[0].worktree, false);
		const conversationId = await page.evaluate(
			async () =>
				(await window.plinycode.invoke({ type: "snapshot" })).state.tasks[0].id,
		);
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Remember ORBIT and say ready.");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
			undefined,
			{ timeout: 40_000 },
		);
		assert.equal(requests[0].model, "snps-provider/kimi-k2.6");
		assert.ok(!(await readdir(folder)).includes(".git"));
		console.log(
			"PASS: ordinary folder runs without Git initialization or worktree preparation",
		);
		await page.screenshot({ path: join(data, "conversation.png") });
		console.log("PASS: Electron → worker → default FreeAuto → streamed answer");
		// Reopen the app and continue the persisted engine conversation.
		await application.close();
		application = await launch();
		page = await application.firstWindow();
		await page.getByRole("button", { name: /Remember ORBIT/ }).click();
		reply = "ORBIT";
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("What marker did I give you?");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.ok(
			JSON.stringify(requests.at(-1)).includes("Remember ORBIT"),
			"Engine history must survive reopening",
		);
		console.log("PASS: persistent multi-turn engine history");
		// Copy uses the native clipboard, including original prompt whitespace.
		await page
			.locator(".message.user")
			.first()
			.getByRole("button", { name: "Copy", exact: true })
			.click();
		await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
		assert.equal(
			await application.evaluate(({ clipboard }) => clipboard.readText()),
			"Remember ORBIT and say ready.",
		);
		const pasteTarget = page.getByRole("textbox", {
			name: "Message PlinyCode",
		});
		await pasteTarget.focus();
		await page.keyboard.press(
			process.platform === "darwin" ? "Meta+V" : "Control+V",
		);
		assert.equal(
			await pasteTarget.inputValue(),
			"Remember ORBIT and say ready.",
		);
		await pasteTarget.fill("DISCARDED_TURN must not survive restart.");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		const beforeRestart = await page.evaluate(
			async () =>
				(await window.plinycode.invoke({ type: "snapshot" })).state.tasks[0],
		);
		const secondPrompt = beforeRestart.messages.filter(
			(entry) => entry.role === "user",
		)[1];
		// Remove this fixture snapshot to exercise migration of pre-feature chats.
		await unlink(
			join(
				data,
				"state",
				"tasks",
				beforeRestart.id,
				"turns",
				`${secondPrompt.id}.json`,
			),
		);
		await page
			.locator(".message.user")
			.nth(1)
			.getByRole("button", { name: "Edit and restart" })
			.click();
		await page
			.getByLabel("Edit earlier prompt")
			.fill("REVISED_PROMPT: repeat the marker.");
		await page
			.getByRole("button", { name: "Restart from here", exact: true })
			.click();
		await page.waitForFunction(
			() =>
				document.querySelectorAll(".message.user").length === 2 &&
				document.querySelector(".badge")?.textContent === "completed",
		);
		assert.ok(JSON.stringify(requests.at(-1)).includes("Remember ORBIT"));
		assert.ok(JSON.stringify(requests.at(-1)).includes("REVISED_PROMPT"));
		assert.ok(!JSON.stringify(requests.at(-1)).includes("DISCARDED_TURN"));
		assert.ok(
			!JSON.stringify(requests.at(-1)).includes("What marker did I give you?"),
		);
		// A second edit uses the new exact pre-turn snapshot.
		await page
			.locator(".message.user")
			.nth(1)
			.getByRole("button", { name: "Edit and restart" })
			.click();
		await page
			.getByLabel("Edit earlier prompt")
			.fill("FINAL_REVISION: repeat the marker.");
		await page
			.getByRole("button", { name: "Restart from here", exact: true })
			.click();
		await page.getByLabel("Edit earlier prompt").waitFor({ state: "detached" });
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.ok(!JSON.stringify(requests.at(-1)).includes("REVISED_PROMPT"));
		assert.ok(JSON.stringify(requests.at(-1)).includes("FINAL_REVISION"));
		await application.close();
		application = await launch();
		page = await application.firstWindow();
		await page.getByRole("button", { name: /Remember ORBIT/ }).click();
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Continue after restart.");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.ok(JSON.stringify(requests.at(-1)).includes("FINAL_REVISION"));
		assert.ok(!JSON.stringify(requests.at(-1)).includes("DISCARDED_TURN"));
		console.log(
			"PASS: native copy/paste, legacy prompt edit, exact restart history and reopen without discarded turns",
		);
		const suggestionComposer = page.getByRole("textbox", {
			name: "Message PlinyCode",
		});
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>(
					'textarea[aria-label="Message PlinyCode"]',
				)?.placeholder === "Add tests for the remaining edge cases.",
		);
		const turnsBeforeSuggestion = await page.locator(".message.user").count();
		assert.equal(await suggestionComposer.inputValue(), "");
		await page.screenshot({ path: join(data, "next-prompt-suggestion.png") });
		await suggestionComposer.press("Tab");
		assert.equal(
			await suggestionComposer.inputValue(),
			"Add tests for the remaining edge cases.",
		);
		assert.equal(
			await page.locator(".message.user").count(),
			turnsBeforeSuggestion,
			"Tab must not send",
		);
		await suggestionComposer.fill("");
		assert.equal(
			await suggestionComposer.getAttribute("placeholder"),
			"Message PlinyCode…",
		);
		console.log(
			"PASS: completed-turn ghost suggestion, Tab fills without sending, edits dismiss",
		);
		// Rewrite is a separate, tool-free request and never sends the draft.
		const composer = page.getByRole("textbox", { name: "Message PlinyCode" });
		const improve = () =>
			page.getByRole("button", { name: "Improve prompt", exact: true });
		const waitImproved = () =>
			page.waitForFunction(
				() =>
					!Array.from(document.querySelectorAll("button")).some(
						(button) => button.textContent === "Improving…",
					),
			);
		assert.equal(await improve().isDisabled(), true);
		const messagesBefore = await page.locator(".message.user").count();
		await composer.fill("plese fix failing tests");
		// A Node fetch bypasses Chromium's proxy and used to time out behind
		// corporate TLS/proxy setups. Require the actual button to use this proxy.
		let proxiedRewrites = 0;
		const rewriteProxy = createServer((request, response) => {
			assert.equal(
				request.url,
				`http://127.0.0.1:${address.port}/v1/chat/completions`,
			);
			proxiedRewrites++;
			server.emit("request", request, response);
		});
		await new Promise<void>((accept) =>
			rewriteProxy.listen(0, "127.0.0.1", accept),
		);
		try {
			const proxyAddress = rewriteProxy.address();
			assert.ok(proxyAddress && typeof proxyAddress !== "string");
			await application.evaluate(async ({ session }, port) => {
				await session.defaultSession.setProxy({
					proxyRules: `http=127.0.0.1:${port}`,
					proxyBypassRules: "<-loopback>",
				});
				await session.defaultSession.closeAllConnections();
			}, proxyAddress.port);
			await improve().click();
			await waitImproved();
			assert.equal(proxiedRewrites, 1, "Rewrite must use Electron networking");
		} finally {
			await application.evaluate(async ({ session }) => {
				await session.defaultSession.setProxy({ mode: "direct" });
				await session.defaultSession.closeAllConnections();
			});
			rewriteProxy.closeAllConnections();
			rewriteProxy.close();
		}
		assert.equal(await composer.inputValue(), improvedReply);
		assert.equal(await page.locator(".message.user").count(), messagesBefore);
		const utilityRequest = requests.at(-1)!;
		assert.ok(
			!utilityRequest.tools || (utilityRequest.tools as unknown[]).length === 0,
		);
		assert.ok(!JSON.stringify(utilityRequest).includes("ORBIT"));
		assert.equal(
			await page.getByLabel("Model", { exact: true }).inputValue(),
			"pliny/auto-free",
		);
		await page.screenshot({ path: join(data, "improve-prompt.png") });
		await page.getByRole("button", { name: "Undo improvement" }).click();
		assert.equal(await composer.inputValue(), "plese fix failing tests");
		improvedReply = "";
		await improve().click();
		await page
			.getByRole("alert")
			.filter({ hasText: "unsuitable rewrite" })
			.waitFor();
		assert.equal(await composer.inputValue(), "plese fix failing tests");
		await composer.fill("x".repeat(8001));
		const beforeOversized = requests.length;
		await improve().click();
		await page.getByRole("alert").filter({ hasText: "8,000" }).waitFor();
		assert.equal(requests.length, beforeOversized);
		for (const changeChat of [false, true]) {
			await composer.fill("original draft");
			improvedReply = "A late rewrite.";
			let release!: () => void;
			waitForRewrite = new Promise<void>((resolve) => {
				release = resolve;
			});
			const before = requests.length;
			await improve().click();
			const deadline = Date.now() + 25_000;
			while (requests.length === before) {
				assert.ok(
					Date.now() < deadline,
					"Rewrite request did not reach the fixture",
				);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			if (changeChat) {
				await page.getByTitle(/New chat in/).click();
				await page.getByRole("button", { name: /Remember ORBIT/ }).click();
			} else {
				await composer.fill("edited draft");
				await composer.fill("original draft");
			}
			release();
			await waitImproved();
			assert.equal(await composer.inputValue(), "original draft");
			assert.equal(
				await page.getByRole("button", { name: "Undo improvement" }).count(),
				0,
			);
			waitForRewrite = undefined;
		}
		console.log(
			"PASS: improve prompt through system proxy, undo, no execution/history, validation and stale-response protection",
		);
		// Disabled edit approval asks; denial must leave the file unchanged.
		const target = join(folder, "result.txt");
		await writeFile(target, "original");
		reply = {
			name: "editor",
			input: { path: target, old_text: "original", new_text: "changed" },
		};
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Change result.txt");
		await sendPrompt(page);
		await page.getByRole("button", { name: "Deny", exact: true }).click();
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.equal(await readFile(target, "utf8"), "original");
		// Full Automatic genuinely executes an edit without a permission card.
		await page.getByLabel("Full Automatic", { exact: true }).click();
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLInputElement>(".full-auto input")?.checked,
		);
		reply = {
			name: "editor",
			input: { path: target, old_text: "original", new_text: "changed" },
		};
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Now change result.txt");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.equal(await readFile(target, "utf8"), "changed");
		console.log("PASS: per-task approval denial and Full Automatic edit");
		// Exercise the real worker's browser tool through the main-process bridge.
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByLabel("Browser extension ID").fill("a".repeat(32));
		await page.getByRole("button", { name: "Start pairing" }).click();
		const pairAddress = await page.getByLabel("Pairing address").inputValue();
		const pairToken = await page.getByLabel("Pairing token").inputValue();
		const browserPeer = new WebSocket(pairAddress, {
			origin: `chrome-extension://${"a".repeat(32)}`,
		});
		await new Promise<void>((accept, reject) => {
			browserPeer.once("open", accept);
			browserPeer.once("error", reject);
		});
		const browserReady = new Promise<void>((accept) =>
			browserPeer.once("message", () => accept()),
		);
		browserPeer.send(JSON.stringify({ type: "hello", token: pairToken }));
		await browserReady;
		let browserCalls = 0;
		browserPeer.on("message", (raw) => {
			const event = JSON.parse(raw.toString());
			if (event.type === "action") {
				browserCalls++;
				browserPeer.send(
					JSON.stringify({
						type: "result",
						id: event.id,
						value: [
							{
								id: 1,
								title: "Signed-in fixture",
								url: "https://example.invalid",
							},
						],
					}),
				);
			}
		});
		await page.getByRole("button", { name: "Refresh connection" }).click();
		await page.getByText("Browser connected", { exact: true }).waitFor();
		await page.getByRole("button", { name: "Save defaults" }).click();
		reply = { name: "browser", input: { operation: "tabs" } };
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("List the browser tabs I shared.");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.equal(browserCalls, 1);
		await page.getByLabel("Web access", { exact: true }).click();
		await page.waitForFunction(
			() =>
				!Array.from(document.querySelectorAll("label"))
					.find((label) => label.textContent === "Web access")
					?.querySelector<HTMLInputElement>("input")?.checked,
		);
		reply = { name: "browser", input: { operation: "tabs" } };
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("List shared tabs again.");
		await sendPrompt(page);
		await page.getByRole("button", { name: "Deny", exact: true }).click();
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.equal(browserCalls, 1);
		await page.getByLabel("Full Automatic", { exact: true }).click();
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLInputElement>(".full-auto input")?.checked,
		);
		browserPeer.close();
		assert.ok(
			!(await readFile(join(data, "state/state.json"), "utf8")).includes(
				pairToken,
			),
		);
		console.log(
			"PASS: browser pairing UI, worker tool dispatch, Full Automatic and denial without browser calls",
		);
		await application.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({
				canceled: false,
				filePaths: [path],
			});
		}, target);
		await page
			.getByRole("button", { name: "Attach files", exact: true })
			.click();
		await page.waitForFunction(
			(path) =>
				document
					.querySelector<HTMLTextAreaElement>(
						'textarea[aria-label="Message PlinyCode"]',
					)
					?.value.includes(JSON.stringify(path)),
			target,
		);
		console.log(
			"PASS: native file selection adds explicit file references to the prompt",
		);
		// Known credentials split over model chunks must never reach UI/history.
		reply = `Never display ${secret}.`;
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Test redaction");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.ok(!(await page.textContent("body"))?.includes(secret));
		assert.ok(
			!(await readFile(join(data, "state/state.json"), "utf8")).includes(
				secret,
			),
		);
		console.log("PASS: credential redaction");
		assert.ok(
			(await page.locator("#model-catalog option").count()) > 1,
			"Model catalog must populate",
		);
		// Background commands survive their initiating turn and can be stopped independently.
		reply = {
			name: "start_background_command",
			input: {
				command:
					process.platform === "win32"
						? "Write-Output 'background-ready'; Start-Sleep -Seconds 120"
						: "echo background-ready; sleep 120",
			},
		};
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Start a background build");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		await page.locator(".command-panel summary").click();
		await page
			.getByRole("button", { name: "Stop command", exact: true })
			.waitFor();
		await page.waitForFunction(() =>
			document
				.querySelector(".command-panel pre")
				?.textContent?.includes("background-ready"),
		);
		reply = "Another turn while the build continues.";
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Keep chatting while the command runs");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		await page
			.getByRole("button", { name: "Stop command", exact: true })
			.click();
		await page.waitForFunction(() =>
			document
				.querySelector(".command-panel summary")
				?.textContent?.includes("stopped"),
		);
		console.log(
			"PASS: background command survives follow-up turns and stops independently",
		);
		reply = {
			name: "spawn_agent",
			input: { task: "Return a short delegated report." },
		};
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Delegate a report");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		const delegated = await page.evaluate(() =>
			window.plinycode.invoke({ type: "snapshot" }),
		);
		assert.ok(
			delegated.state.tasks
				.find((task) => task.id === conversationId)
				?.subagents?.some(
					(agent) =>
						agent.status === "completed" && agent.text.includes("Done."),
				),
			"Delegated transcript and completion must be persisted",
		);
		await page.locator(".subagent-card summary").first().click();
		assert.ok(
			(await page.locator(".subagent-card").first().textContent())?.includes(
				"Done.",
			),
		);
		console.log(
			"PASS: actual FreeAuto delegation and visible persistent child transcript",
		);
		// Configure a real MCP transport through the settings UI and exercise secure storage.
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page
			.getByRole("button", { name: "Add MCP server", exact: true })
			.click();
		await page.getByLabel("MCP server name", { exact: true }).fill("fixture");
		await page
			.getByLabel("MCP transport", { exact: true })
			.selectOption("http");
		await page
			.getByLabel("MCP endpoint", { exact: true })
			.fill(`http://127.0.0.1:${address.port}/mcp`);
		await page.getByLabel("MCP encrypted values", { exact: true }).fill(
			JSON.stringify({
				headers: { Authorization: "Bearer mcp-fixture-token" },
			}),
		);
		await page
			.getByRole("button", { name: "Save MCP server", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Test fixture", exact: true })
			.click();
		await page
			.getByRole("status")
			.filter({ hasText: "Connected. Tools: fixture__echo" })
			.waitFor();
		assert.ok(
			!(await readFile(join(data, "state/mcp-secrets.json"), "utf8")).includes(
				"mcp-fixture-token",
			),
		);
		assert.ok(!(await page.textContent("body"))?.includes("mcp-fixture-token"));
		if (await page.locator(".error-toast").count())
			console.log(
				"Desktop toast before saving settings:",
				await page.locator(".error-toast").textContent(),
			);
		await page
			.getByRole("button", { name: "Save defaults", exact: true })
			.click();
		reply = { name: "fixture__echo", input: { value: "mcp-fixture-token" } };
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Use the MCP echo tool");
		await sendPrompt(page);
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "completed",
		);
		assert.equal(mcpCalls, 1);
		const withMcp = await page.evaluate(() =>
			window.plinycode.invoke({ type: "snapshot" }),
		);
		assert.ok(!JSON.stringify(withMcp).includes("mcp-fixture-token"));
		const current = withMcp.state.tasks.find(
			(task) => task.id === conversationId,
		);
		assert.ok(current);
		await page.evaluate(
			(task) =>
				window.plinycode.invoke({
					type: "configureTask",
					id: task.id,
					model: task.model,
					permissions: { ...task.permissions, mcp: false },
				}),
			current,
		);
		await page
			.getByRole("textbox", { name: "Message PlinyCode" })
			.fill("Request an unapproved connection");
		await sendPrompt(page);
		await page.getByRole("button", { name: "Deny", exact: true }).click();
		await page.waitForFunction(
			() => document.querySelector(".badge")?.textContent === "failed",
		);
		assert.equal(mcpCalls, 1, "Denied discovery must not execute a tool");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Disable", exact: true }).click();
		await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
		await page
			.getByRole("button", { name: "Save defaults", exact: true })
			.click();
		console.log(
			"PASS: MCP settings, encrypted credentials, connection test, tool execution and denied connection",
		);
		// Ordinary folder writers wait, then cancellation releases the folder.
		hang = true;
		const snapshot = await page.evaluate(() =>
			window.plinycode.invoke({ type: "snapshot" }),
		);
		const first = conversationId;
		await page.evaluate(
			(id) =>
				window.plinycode.invoke({
					type: "send",
					id,
					prompt: "Wait until cancelled",
				}),
			first,
		);
		const second = await page.evaluate(
			(projectId) =>
				window.plinycode.invoke({
					type: "createTask",
					projectId,
					worktree: false,
				}),
			snapshot.state.projects[0].id,
		);
		await page.evaluate(
			(id) =>
				window.plinycode.invoke({
					type: "send",
					id,
					prompt: "Wait for folder",
				}),
			second.selectedTask!,
		);
		const queued = await page.evaluate(() =>
			window.plinycode.invoke({ type: "snapshot" }),
		);
		assert.equal(
			queued.state.tasks.find((task) => task.id === second.selectedTask)
				?.status,
			"queued",
		);
		hang = false;
		reply = "Folder released.";
		await page.evaluate(
			(id) => window.plinycode.invoke({ type: "cancel", id }),
			first,
		);
		await page.waitForFunction(
			async (id) =>
				(await window.plinycode.invoke({ type: "snapshot" })).state.tasks.find(
					(task) => task.id === id,
				)?.status === "completed",
			second.selectedTask,
		);
		console.log("PASS: folder serialization and cancellation");
		async function assertRedacted(directory: string): Promise<void> {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await assertRedacted(path);
				else {
					const bytes = await readFile(path);
					assert.ok(
						!bytes.includes(Buffer.from(secret)),
						`Gateway secret persisted in ${path}`,
					);
					assert.ok(
						!bytes.includes(Buffer.from("mcp-fixture-token")),
						`MCP secret persisted in ${path}`,
					);
				}
			}
		}
		await assertRedacted(join(data, "state"));
		console.log(
			"PASS: known secrets absent from persisted engine transcripts, hook audits and databases",
		);
		await page.screenshot({ path: join(data, "final.png") });
		const requestCount = requests.length;
		await application.close();
		application = await launch();
		page = await application.firstWindow();
		const reopened = await page.evaluate(() =>
			window.plinycode.invoke({ type: "snapshot" }),
		);
		assert.equal(
			requests.length,
			requestCount,
			"Reopening must not replay work",
		);
		assert.ok(
			reopened.state.tasks.some((task) =>
				task.subagents?.some(
					(agent) =>
						agent.status === "completed" && agent.text.includes("Done."),
				),
			),
		);
		assert.ok(
			reopened.state.commands?.some((command) => command.status === "stopped"),
		);
		const savedServer = reopened.state.mcpServers?.find(
			(server) => server.name === "fixture",
		);
		assert.ok(savedServer && !savedServer.enabled && savedServer.hasSecrets);
		fixtureToolName = "mcp-fixture-token";
		const probe = await page.evaluate(
			(id) => window.plinycode.invoke({ type: "testMcp", id }),
			savedServer.id,
		);
		assert.deepEqual(probe.mcpTools, ["fixture__[REDACTED]"]);
		console.log(
			"PASS: restart restores delegated history and command state without replay, and decrypts MCP credentials for an explicit test",
		);
		console.log(`Desktop E2E evidence: ${data}`);
	}
	// Real worktree and PR controls; provider requests remain local fixture GETs.
	const gitFolder = join(data, "git-project"),
		bare = join(data, "remote.git");
	await mkdir(gitFolder);
	const runGit = async (cwd: string, args: string[]) =>
		promisify(execFile)("git", args, { cwd, windowsHide: true, env });
	// Match a local-only project such as Magik, including recovery of an old
	// project configured with the default origin even though no remote exists.
	const localFolder = join(data, "local-project");
	await mkdir(localFolder);
	await runGit(localFolder, ["init", "--initial-branch=local-main"]);
	await runGit(localFolder, ["config", "user.name", "Desktop fixture"]);
	await runGit(localFolder, [
		"config",
		"user.email",
		"fixture@example.invalid",
	]);
	await writeFile(join(localFolder, "local.txt"), "committed local content");
	await runGit(localFolder, ["add", "."]);
	await runGit(localFolder, ["commit", "-m", "Initial local commit"]);
	await writeFile(join(localFolder, "local.txt"), "uncommitted source content");
	await application.evaluate(({ dialog }, folder) => {
		delete process.env.PLINY_DESKTOP_TEST_PROJECT;
		dialog.showOpenDialog = async () => ({
			canceled: false,
			filePaths: [folder],
		});
	}, localFolder);
	await page.getByRole("button", { name: /Add project/ }).click();
	await page
		.locator("main .eyebrow")
		.filter({ hasText: "local-project /" })
		.waitFor();
	const localSettings = () =>
		page
			.locator(".project")
			.filter({ hasText: "local-project" })
			.getByTitle("Project settings")
			.click();
	await localSettings();
	assert.equal(
		await page.getByLabel("Worktree source", { exact: true }).inputValue(),
		"local",
	);
	await page
		.getByLabel("Worktree source", { exact: true })
		.selectOption("remote");
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Message PlinyCode" })
		.fill("Start with a missing remote.");
	await sendPrompt(page);
	await page.waitForFunction(
		() => document.querySelector(".badge")?.textContent === "failed",
	);
	await page.getByText(/Git remote "origin" is not configured/).waitFor();
	await application.close();
	const legacyStatePath = join(data, "state", "state.json");
	const legacyState = JSON.parse(await readFile(legacyStatePath, "utf8"));
	delete legacyState.projects.find(
		(project: { name: string }) => project.name === "local-project",
	).worktreeSource;
	await writeFile(legacyStatePath, JSON.stringify(legacyState));
	application = await launch();
	page = await application.firstWindow();
	await page
		.getByRole("button", { name: /Start with a missing remote/ })
		.click();
	await localSettings();
	assert.equal(
		await page.getByLabel("Worktree source", { exact: true }).inputValue(),
		"local",
		"Legacy local-only project must migrate without manual settings changes",
	);
	await page
		.getByLabel("Worktree source", { exact: true })
		.selectOption("local");
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await page
		.getByLabel("Worktree source", { exact: true })
		.waitFor({ state: "hidden" });
	await page
		.getByLabel("Explicitly use last fetched revision")
		.waitFor({ state: "detached" });
	assert.equal(
		await page.getByLabel("Explicitly use last fetched revision").count(),
		0,
	);
	await page
		.getByRole("textbox", { name: "Message PlinyCode" })
		.fill("Run in an isolated local worktree.");
	await sendPrompt(page);
	await page.waitForFunction(
		() => document.querySelector(".badge")?.textContent === "completed",
		undefined,
		{ timeout: 40_000 },
	);
	const localState = await page.evaluate(
		async () => (await window.plinycode.invoke({ type: "snapshot" })).state,
	);
	const localProject = localState.projects.find(
		(project) => project.name === "local-project",
	);
	assert.ok(localProject);
	const localTask = localState.tasks.find(
		(task) => task.projectId === localProject.id,
	);
	assert.ok(localTask?.cwd);
	assert.notEqual(resolve(localTask.cwd), resolve(localFolder));
	assert.equal(localTask.baseBranch, "local-main");
	assert.equal(
		await readFile(join(localTask.cwd, "local.txt"), "utf8"),
		"committed local content",
	);
	assert.equal(
		await readFile(join(localFolder, "local.txt"), "utf8"),
		"uncommitted source content",
	);
	assert.equal((await runGit(localFolder, ["remote"])).stdout.trim(), "");
	await page.screenshot({ path: join(data, "local-worktree.png") });
	console.log(
		"PASS: local-only Git worktree, missing-remote recovery, source changes preserved and no remote added",
	);
	await runGit(data, ["init", "--bare", "--initial-branch=main", bare]);
	await runGit(gitFolder, ["init", "--initial-branch=main"]);
	await runGit(gitFolder, ["config", "user.name", "Desktop fixture"]);
	await runGit(gitFolder, ["config", "user.email", "fixture@example.invalid"]);
	await writeFile(join(gitFolder, "file.txt"), "initial");
	await runGit(gitFolder, ["add", "."]);
	await runGit(gitFolder, ["commit", "-m", "initial"]);
	await runGit(gitFolder, ["remote", "add", "origin", bare]);
	await runGit(gitFolder, ["push", "origin", "main"]);
	await application.evaluate(({ dialog }, folder) => {
		delete process.env.PLINY_DESKTOP_TEST_PROJECT;
		dialog.showOpenDialog = async () => ({
			canceled: false,
			filePaths: [folder],
		});
	}, gitFolder);
	await page.getByRole("button", { name: /Add project/ }).click();
	await page
		.locator("main .eyebrow")
		.filter({ hasText: "git-project /" })
		.waitFor();
	reply = "Worktree ready.";
	await page
		.getByRole("textbox", { name: "Message PlinyCode" })
		.fill("Prepare a task for PR review.");
	await sendPrompt(page);
	await page.waitForFunction(
		() => document.querySelector(".badge")?.textContent === "completed",
		undefined,
		{ timeout: 30_000 },
	);
	await page
		.locator(".project")
		.filter({ hasText: "git-project" })
		.getByTitle("Project settings")
		.click();
	await page.getByLabel("GitHub owner").fill("fixture");
	await page.getByLabel("Repository name", { exact: true }).fill("repository");
	await page
		.getByLabel("New provider access token")
		.fill("provider-fixture-secret");
	await page.getByRole("button", { name: "Save PR settings" }).click();
	await page.getByText(/PR settings saved/).waitFor();
	await page.getByLabel("PR provider", { exact: true }).selectOption("azure");
	await page
		.getByLabel("Organization or collection URL")
		.fill(`http://127.0.0.1:${address.port}/collection`);
	await page.getByLabel("Azure project").fill("fixture");
	await page.getByLabel("Azure API version").selectOption("6.0");
	await page
		.getByLabel("New provider access token")
		.fill("provider-fixture-secret");
	await page.getByRole("button", { name: "Save PR settings" }).click();
	await page.waitForFunction(async () =>
		(await window.plinycode.invoke({ type: "snapshot" })).state.projects.some(
			(project) => project.prRepository?.provider === "azure",
		),
	);
	await page.getByRole("button", { name: "Save project" }).click();
	await page.getByRole("button", { name: "Create PR", exact: true }).click();
	await page.getByLabel("PR target branch").waitFor();
	await page.waitForFunction(
		() =>
			Array.from(document.querySelectorAll(".pr-dialog label"))
				.find((label) => label.textContent?.includes("PR target branch"))
				?.querySelector<HTMLInputElement>("input")?.value === "main",
	);
	assert.equal(await page.getByLabel("PR target branch").inputValue(), "main");
	await page.getByLabel("PR title", { exact: true }).fill("Fixture PR title");
	await page.getByLabel("PR description").fill("Fixture body");
	await page.getByRole("button", { name: "Refresh PR status" }).click();
	await page.getByText(/No open PR found; inspect/).waitFor();
	await page.screenshot({ path: join(data, "pr-controls.png") });
	await page.getByRole("button", { name: "Close PR dialog" }).click();
	const finalState = await page.evaluate(() =>
		window.plinycode.invoke({ type: "snapshot" }),
	);
	assert.ok(!JSON.stringify(finalState).includes("provider-fixture-secret"));
	assert.ok(
		!(await readFile(join(data, "state/mcp-secrets.json"), "utf8")).includes(
			"provider-fixture-secret",
		),
	);
	assert.equal(
		(await runGit(gitFolder, ["status", "--porcelain"])).stdout.trim(),
		"",
	);
	console.log(
		"PASS: PR settings for GitHub and Azure Server, encrypted token, real worktree preview and read-only PR refresh",
	);
} catch (error) {
	const page = application.windows()[0];
	if (page) {
		console.error(
			"Desktop visible alerts:",
			await page
				.locator('[role="alert"]')
				.allTextContents()
				.catch(() => []),
		);
		await page.screenshot({ path: join(data, "failure.png") }).catch(() => {});
	}
	throw error;
} finally {
	await application.close();
	server.closeAllConnections();
	server.close();
}

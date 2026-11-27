/** Real Electron/engine acceptance against a controlled local streaming gateway. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(root, "../../ai_output");
await mkdir(scratch, { recursive: true });
const data = await mkdtemp(join(scratch, "desktop-interactions-e2e-"));
const project = join(data, "project");
await mkdir(project);
const requests: Array<{
	body: Record<string, unknown>;
	output: ServerResponse;
}> = [];
function chunk(output: ServerResponse, text: string, done = false) {
	output.write(
		`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: done ? {} : { content: text }, finish_reason: done ? "stop" : null }] })}\n\n`,
	);
	if (done) output.end("data: [DONE]\n\n");
}
const server = createServer(async (request, output) => {
	let text = "";
	for await (const part of request) text += part.toString();
	const body = JSON.parse(text);
	output.writeHead(200, { "content-type": "text/event-stream" });
	output.write(": ready\n\n");
	if (
		JSON.stringify(body.messages).includes(
			"Suggest the single most useful next message",
		)
	) {
		chunk(output, "Review the changes.");
		chunk(output, "", true);
	} else requests.push({ body, output });
});
await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No fixture port");
const env: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	),
	PLINY_DESKTOP_DATA: join(data, "state"),
	PLINY_DESKTOP_TEST_PROJECT: project,
	PLINY_API_KEY: "interaction-fixture-key",
	PLINY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
	GIT_CEILING_DIRECTORIES: data,
};
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
	_electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [root, `--user-data-dir=${join(data, "profile")}`],
		env,
		timeout: 40_000,
	});
async function until(check: () => boolean) {
	const deadline = Date.now() + 30_000;
	while (!check()) {
		if (Date.now() > deadline)
			throw new Error("Timed out waiting for gateway request");
		await new Promise((accept) => setTimeout(accept, 20));
	}
}
let application = await launch();
try {
	let page = await application.firstWindow();
	page.on("pageerror", (error) => console.error(error));
	await page.getByRole("button", { name: /Add project/ }).click();
	let composer = page.getByRole("textbox", { name: "Message PlinyCode" });
	await composer.fill("Start the original task");
	await page.getByRole("button", { name: /^Send/ }).click();
	await until(() => requests.length === 1);
	chunk(
		requests[0].output,
		Array.from(
			{ length: 80 },
			(_, i) => `Paragraph ${i}: original progress.\n\n`,
		).join(""),
	);
	await page
		.getByText("Paragraph 79: original progress.", { exact: true })
		.waitFor();
	await page.waitForFunction(() => {
		const el = document.querySelector(".conversation")!;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
	});
	// Reproduce a layout-induced scroll before ResizeObserver has a chance to run,
	// as happens with Chromium scroll anchoring when streamed content grows.
	const layoutDistances = await page.locator(".conversation").evaluate((el) => {
		const extra = document.createElement("div");
		extra.style.height = "600px";
		el.firstElementChild!.append(extra);
		el.dispatchEvent(new Event("scroll"));
		const grown = el.scrollHeight - el.scrollTop - el.clientHeight;
		extra.remove();
		el.dispatchEvent(new Event("scroll"));
		return [grown, el.scrollHeight - el.scrollTop - el.clientHeight];
	});
	assert.ok(
		layoutDistances.every((distance) => distance < 48),
		"Layout scrolls must preserve follow mode before resize observers run",
	);
	await page.locator(".conversation").evaluate((el) => {
		el.scrollTop = 160;
	});
	await page.getByRole("button", { name: "Jump to latest" }).waitFor();
	const before = await page
		.locator(".conversation")
		.evaluate((el) => el.scrollTop);
	chunk(requests[0].output, "Additional streamed progress.\n\n");
	await page
		.getByText("Additional streamed progress.", { exact: true })
		.waitFor();
	assert.ok(
		Math.abs(
			(await page.locator(".conversation").evaluate((el) => el.scrollTop)) -
				before,
		) < 4,
		"Streaming must not move a reader away from earlier messages",
	);
	await composer.fill("Use the corrected requirement instead");
	await page.getByRole("button", { name: "Steer task", exact: true }).click();
	// A fast engine can consume the steer before React paints its pending badge.
	// Wait for durable acceptance; the gateway assertions below prove delivery.
	await page.waitForFunction(async () => {
		const { state } = await window.plinycode.invoke({ type: "snapshot" });
		return state.tasks.some(
			(task) =>
				task.pendingMessages?.some(
					(entry) => entry.text === "Use the corrected requirement instead",
				) ||
				task.messages.some(
					(entry) =>
						entry.role === "user" &&
						entry.text === "Use the corrected requirement instead",
				),
		);
	});
	await composer.fill("Then run a separate follow-up");
	await page
		.getByRole("button", { name: "Queue follow-up", exact: true })
		.click();
	await page.getByText("Follow-up queued", { exact: true }).waitFor();
	chunk(requests[0].output, "", true);
	await until(() => requests.length >= 2);
	assert.ok(
		JSON.stringify(requests[1].body.messages).includes(
			"Use the corrected requirement instead",
		),
		"The next model request must include steering",
	);
	assert.ok(
		!JSON.stringify(requests[1].body.messages).includes(
			"Then run a separate follow-up",
		),
		"Queued follow-up must wait for its own turn",
	);
	chunk(
		requests[1].output,
		"Correction applied. [Open docs](https://example.com/docs) [Unsafe](file:///C:/unsafe.exe)",
	);
	chunk(requests[1].output, "", true);
	await until(() => requests.length >= 3);
	assert.ok(
		JSON.stringify(requests[2].body.messages).includes(
			"Then run a separate follow-up",
		),
	);
	chunk(requests[2].output, "Follow-up completed.");
	chunk(requests[2].output, "", true);
	await page.locator("header .badge.completed").waitFor();
	assert.equal(await page.locator(".pending-message").count(), 0);
	assert.equal(
		await page
			.locator(".message.user")
			.filter({ hasText: "Use the corrected requirement instead" })
			.count(),
		1,
	);
	console.log(
		"PASS: live steering reaches engine history once; queued follow-up executes after completion",
	);

	await page.getByRole("button", { name: "Jump to latest" }).click();
	await page.waitForFunction(() => {
		const el = document.querySelector(".conversation")!;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
	});
	await application.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			(globalThis as typeof globalThis & { opened?: string }).opened = url;
		};
	});
	await page.getByRole("link", { name: "Open docs" }).click();
	assert.equal(
		await application.evaluate(
			() => (globalThis as typeof globalThis & { opened?: string }).opened,
		),
		"https://example.com/docs",
	);
	assert.equal(await page.getByRole("link", { name: "Unsafe" }).count(), 0);
	assert.equal(
		await page.evaluate(async () => {
			try {
				await window.plinycode.invoke({
					type: "openLink",
					url: "file:///C:/unsafe.exe",
				});
				return false;
			} catch {
				return true;
			}
		}),
		true,
		"Main process must also reject unsafe URLs",
	);
	console.log(
		"PASS: web links reach OS handler, unsafe links are blocked in renderer and main",
	);

	await composer.fill("Draft A survives restart");
	await page.locator(".conversation").evaluate((el) => {
		el.scrollTop = 200;
	});
	await page.getByRole("button", { name: "Jump to latest" }).waitFor();
	await page.getByTitle("New chat in project").click();
	await page.waitForFunction(
		() => document.querySelectorAll(".chat-link").length === 2,
	);
	await page.waitForFunction(
		() =>
			(
				document.querySelector(
					'textarea[aria-label="Message PlinyCode"]',
				) as HTMLTextAreaElement
			)?.value === "",
	);
	await composer.fill("Draft B survives restart");
	await page.locator(".chat-link").nth(1).click();
	await page.waitForFunction(
		() =>
			(
				document.querySelector(
					'textarea[aria-label="Message PlinyCode"]',
				) as HTMLTextAreaElement
			)?.value === "Draft A survives restart",
	);
	assert.equal(await composer.inputValue(), "Draft A survives restart");
	assert.ok(
		Math.abs(
			(await page.locator(".conversation").evaluate((el) => el.scrollTop)) -
				200,
		) < 4,
	);
	await composer.fill("Draft A saved immediately before closing");
	await application.close();
	application = await launch();
	page = await application.firstWindow();
	composer = page.getByRole("textbox", { name: "Message PlinyCode" });
	await page.locator(".chat-link").nth(1).click();
	await page.waitForFunction(
		() =>
			(
				document.querySelector(
					'textarea[aria-label="Message PlinyCode"]',
				) as HTMLTextAreaElement
			)?.value === "Draft A saved immediately before closing",
	);
	await page.locator(".chat-link").nth(0).click();
	await page.waitForFunction(
		() =>
			(
				document.querySelector(
					'textarea[aria-label="Message PlinyCode"]',
				) as HTMLTextAreaElement
			)?.value === "Draft B survives restart",
	);
	assert.equal(await composer.inputValue(), "Draft B survives restart");
	console.log(
		"PASS: per-chat reading positions and drafts survive switching; drafts survive full app restart",
	);

	await composer.fill("Start task to cancel");
	await page.getByRole("button", { name: /^Send/ }).click();
	await until(() => requests.length >= 4);
	await composer.fill("Do not replay this automatically");
	await page
		.getByRole("button", { name: "Queue follow-up", exact: true })
		.click();
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	await page.locator("header .badge.cancelled").waitFor();
	await page
		.getByText("Not resent — review before sending", { exact: true })
		.waitFor();
	assert.equal(requests.length, 4);
	await page.screenshot({ path: join(data, "held-follow-up.png") });
	await application.close();
	application = await launch();
	page = await application.firstWindow();
	await page.locator(".chat-link").nth(0).click();
	await page
		.getByText("Not resent — review before sending", { exact: true })
		.waitFor();
	assert.equal(requests.length, 4);
	console.log(
		"PASS: cancellation and restart preserve pending text without replaying it",
	);
} catch (error) {
	const page = await application.firstWindow().catch(() => undefined);
	await page?.screenshot({ path: join(data, "failure.png") }).catch(() => {});
	console.error(
		"Interaction failure state:",
		await page
			?.evaluate(async () => {
				const { state } = await window.plinycode.invoke({ type: "snapshot" });
				return state.tasks.map((task) => ({
					title: task.title,
					status: task.status,
					error: task.error,
					pending: task.pendingMessages,
				}));
			})
			.catch(() => undefined),
	);
	throw error;
} finally {
	await application.close();
	server.closeAllConnections();
	server.close();
}

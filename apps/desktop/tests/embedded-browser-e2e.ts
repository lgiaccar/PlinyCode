/** Real embedded Chromium + Desktop worker; only local fixtures and an isolated profile. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import type { BrowserAction } from "../src/browser-contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(root, "../../ai_output");
await mkdir(scratch, { recursive: true });
const data = await mkdtemp(join(scratch, "desktop-embedded-browser-"));
const project = join(data, "project");
await mkdir(project);
let next: BrowserAction | undefined;
let lastRequest: { messages: { role: string; content: unknown }[] };
let callId = 0;
let saved = "";
const server = createServer(async (request, response) => {
	if (request.url?.startsWith("/page")) {
		response.setHeader("Content-Type", "text/html");
		response.end(`<title>Embedded fixture</title><h1>Local browser fixture</h1>
		<label>Report name<input id="name"></label><textarea aria-label="Notes"></textarea>
		<select aria-label="Priority"><option>Low</option><option>High</option></select>
		<input type="password" aria-label="Password"><input readonly aria-label="Read only">
		<button disabled>Disabled</button><button id="save" onclick="fetch('/save?name='+encodeURIComponent(document.querySelector('#name').value));document.querySelector('output').textContent='Saved '+document.querySelector('#name').value">Save report</button>
		<a href="/page-two">Next page</a><a href="file:///C:/secret">Blocked file link</a>
		<a href="/page-popup" target="_blank">Popup</a><output>${request.url === "/page-two" ? "Second page" : ""}</output>`);
		return;
	}
	if (request.url?.startsWith("/save")) {
		saved =
			new URL(request.url, "http://localhost").searchParams.get("name") ?? "";
		response.end("ok");
		return;
	}
	if (request.url === "/slow") return; // aborted navigation fixture
	let input = "";
	for await (const chunk of request) input += chunk;
	const body = JSON.parse(input);
	const suggestion = JSON.stringify(body.messages).includes(
		"Suggest up to three distinct useful next messages",
	);
	if (!suggestion) lastRequest = body;
	const action = suggestion ? undefined : next;
	if (!suggestion) next = undefined;
	const delta = action
		? {
				tool_calls: [
					{
						index: 0,
						id: `browser-${++callId}`,
						type: "function",
						function: { name: "browser", arguments: JSON.stringify(action) },
					},
				],
			}
		: { content: suggestion ? "[]" : "Done." };
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(
		`${[delta, {}]
			.map(
				(part) =>
					`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: part, finish_reason: Object.keys(part).length ? null : action ? "tool_calls" : "stop" }] })}\n\n`,
			)
			.join("")}data: [DONE]\n\n`,
	);
});
await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
const address = server.address();
if (!address || typeof address === "string")
	throw new Error("Fixture port missing");
const origin = `http://127.0.0.1:${address.port}`;
const env: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	),
	PLINY_DESKTOP_DATA: join(data, "state"),
	PLINY_DESKTOP_TEST_PROJECT: project,
	PLINY_API_KEY: "embedded-browser-fixture-key",
	PLINY_BASE_URL: `${origin}/v1`,
	GIT_CEILING_DIRECTORIES: data,
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron
	.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [root, `--user-data-dir=${join(data, "profile")}`],
		env,
		timeout: 40_000,
	})
	.catch((error) => {
		server.closeAllConnections();
		server.close();
		throw error;
	});
try {
	const page = await application.firstWindow();
	if (!process.env.PLINY_DESKTOP_EMBEDDED_LIFECYCLE_ONLY) {
		await page.getByRole("button", { name: "Choose a project folder" }).click();
		await page.getByRole("button", { name: "Add folders…" }).click();
		await page
			.getByRole("button", { name: "Create project", exact: true })
			.click();
		await page.getByLabel("Full Automatic", { exact: true }).click();
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLInputElement>(".full-auto input")?.checked,
		);
		const act = async (action: BrowserAction, deny = false) => {
			next = action;
			const count = await page.locator(".message.user").count();
			await page
				.getByRole("textbox", { name: "Message PlinyCode" })
				.fill(`Browser fixture ${callId + 1}: ${action.operation}`);
			await page.getByRole("button", { name: /^Send/ }).click();
			await page.waitForFunction(
				(before) => document.querySelectorAll(".message.user").length > before,
				count,
			);
			if (deny)
				await page.getByRole("button", { name: "Deny", exact: true }).click();
			await page.waitForFunction(
				() => document.querySelector(".badge")?.textContent === "completed",
				undefined,
				{ timeout: 40_000 },
			);
			await writeFile(
				join(data, "last-request.json"),
				JSON.stringify(lastRequest, null, 2),
			);
			return lastRequest.messages
				.filter((message) => message.role === "tool")
				.at(-1)?.content;
		};
		const snapshot = async () => {
			const content = await act({ operation: "read", tabId: 0 });
			assert.equal(typeof content, "string");
			return JSON.parse(content as string) as {
				text: string;
				elements: { ref: number; label: string }[];
			};
		};
		await act({ operation: "navigate", url: `${origin}/page` });
		await page.getByLabel("Browser address").waitFor();
		assert.equal(
			await page.getByLabel("Browser address").inputValue(),
			`${origin}/page`,
		);
		let read = await snapshot();
		assert.match(read.text, /Local browser fixture/);
		const ref = (label: string) => {
			const element = read.elements.find((element) => element.label === label);
			assert.ok(element, `Missing ${label}`);
			return element.ref;
		};
		const stale = ref("Report name");
		read = await snapshot();
		assert.match(
			JSON.stringify(
				await act({ operation: "fill", ref: stale, text: "wrong" }),
			),
			/fresh read|snapshot/,
		);
		await act({
			operation: "fill",
			ref: ref("Report name"),
			text: "Quarterly report",
		});
		await act({ operation: "fill", ref: ref("Notes"), text: "Reviewed" });
		await act({ operation: "fill", ref: ref("Priority"), text: "High" });
		assert.match(
			JSON.stringify(
				await act({
					operation: "fill",
					ref: ref("Password"),
					text: "must-not-fill",
				}),
			),
			/passwords.*manually/,
		);
		assert.match(
			JSON.stringify(
				await act({ operation: "fill", ref: ref("Read only"), text: "no" }),
			),
			/read-only/,
		);
		assert.match(
			JSON.stringify(await act({ operation: "click", ref: ref("Disabled") })),
			/disabled/,
		);
		await act({ operation: "click", ref: ref("Save report") });
		assert.equal(saved, "Quarterly report");
		read = await snapshot();
		assert.match(read.text, /Saved Quarterly report/);
		const isolation = await application.evaluate(
			async ({ webContents }, origin) => {
				const browser = webContents
					.getAllWebContents()
					.find((contents) => contents.getURL().startsWith(`${origin}/page`));
				if (!browser) throw new Error("Embedded page not found");
				return browser.executeJavaScript(
					"({node: typeof require, desktop: typeof window.plinycode, refs: typeof window.plinyElements})",
				);
			},
			origin,
		);
		assert.deepEqual(isolation, {
			node: "undefined",
			desktop: "undefined",
			refs: "undefined",
		});
		console.log(
			"PASS: real worker navigate/read/click/fill, fresh refs, password/read-only/disabled guards",
		);
		await page.screenshot({ path: join(data, "browser-pane.png") });
		// Playwright screenshots capture the app renderer, excluding native child views.
		const browserImage = await application.evaluate(
			async ({ webContents }, origin) => {
				const browser = webContents
					.getAllWebContents()
					.find((contents) => contents.getURL().startsWith(`${origin}/page`));
				if (!browser) throw new Error("Embedded page not found");
				return (await browser.capturePage()).toPNG().toString("base64");
			},
			origin,
		);
		await writeFile(
			join(data, "browser-content.png"),
			Buffer.from(browserImage, "base64"),
		);
		if (process.platform === "win32") {
			const composite = await application.evaluate(
				async ({ BrowserWindow, desktopCapturer }) => {
					const window = BrowserWindow.getAllWindows()[0];
					const sources = await desktopCapturer.getSources({
						types: ["window"],
						thumbnailSize: { width: 1600, height: 1200 },
					});
					return sources
						.find((source) => source.id === window.getMediaSourceId())
						?.thumbnail.toPNG()
						.toString("base64");
				},
			);
			if (composite)
				await writeFile(
					join(data, "browser-window.png"),
					Buffer.from(composite, "base64"),
				);
		}
		await page
			.getByRole("button", { name: "Take control", exact: true })
			.click();
		assert.match(
			JSON.stringify(
				await act({ operation: "navigate", url: `${origin}/page-two` }),
			),
			/user has browser control/,
		);
		await page.getByLabel("Browser address").fill(`${origin}/page-two`);
		await page.getByRole("button", { name: "Go", exact: true }).click();
		await page.getByRole("button", { name: "Browser back" }).waitFor();
		await page.waitForFunction(
			() =>
				!(
					document.querySelector(
						'[aria-label="Browser back"]',
					) as HTMLButtonElement
				)?.disabled,
		);
		await page.getByRole("button", { name: "Browser back" }).click();
		await page.waitForFunction(
			(url) =>
				(
					document.querySelector(
						'[aria-label="Browser address"]',
					) as HTMLInputElement
				)?.value === url,
			`${origin}/page`,
		);
		await page.getByRole("button", { name: "Browser forward" }).click();
		await page.waitForFunction(
			(url) =>
				(
					document.querySelector(
						'[aria-label="Browser address"]',
					) as HTMLInputElement
				)?.value === url,
			`${origin}/page-two`,
		);
		await page.getByRole("button", { name: "Reload browser" }).click();
		await page
			.getByRole("button", { name: "Allow agent", exact: true })
			.click();
		read = await snapshot();
		assert.match(read.text, /Second page/);
		assert.match(
			JSON.stringify(
				await act({ operation: "navigate", url: "file:///C:/secret" }),
			),
			/HTTP or HTTPS/,
		);
		assert.equal(
			await page.getByLabel("Browser address").inputValue(),
			`${origin}/page-two`,
		);
		console.log(
			"PASS: manual takeover, navigation history, reload and URL restrictions",
		);
		const native = () =>
			application.evaluate(({ BrowserWindow }) => {
				const win = BrowserWindow.getAllWindows()[0];
				const view = win.contentView.children[0];
				return {
					visible: view?.getVisible(),
					bounds: view?.getBounds(),
					size: win.getContentSize(),
				};
			});
		await page.getByLabel("Browser width").fill("700");
		await page.waitForTimeout(100);
		const viewport = await page.locator(".browser-viewport").boundingBox();
		assert.ok(viewport);
		let geometry = await native();
		assert.ok(geometry.visible);
		assert.ok(Math.abs(geometry.bounds.x - viewport.x) <= 1);
		assert.ok(Math.abs(geometry.bounds.width - viewport.width) <= 1);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.waitForTimeout(100);
		assert.equal(
			(await native()).visible,
			false,
			"Native browser must not cover settings",
		);
		await page.getByRole("button", { name: "Save defaults" }).click();
		await page.waitForTimeout(100);
		assert.equal((await native()).visible, true);
		await application.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].setSize(1000, 750),
		);
		await page.waitForTimeout(100);
		geometry = await native();
		assert.ok(geometry.bounds.x + geometry.bounds.width <= geometry.size[0]);
		await page.getByRole("button", { name: "Close browser" }).click();
		assert.equal((await native()).visible, false);
		await page.getByRole("button", { name: "Browser", exact: true }).click();
		assert.equal(
			await page.getByLabel("Browser address").inputValue(),
			`${origin}/page-two`,
		);
		console.log("PASS: right-pane resizing, modal layering, close and reopen");
		await page.getByLabel("Web access", { exact: true }).click();
		await act({ operation: "navigate", url: `${origin}/page` }, true);
		assert.equal(
			await page.getByLabel("Browser address").inputValue(),
			`${origin}/page-two`,
		);
		console.log("PASS: denied Web access prevents embedded browser actions");
	}
	const lifecycle = await application.evaluate(
		async ({ BrowserWindow }, { bundle, origin }) => {
			const { EmbeddedBrowser } = process
				.getBuiltinModule("module")
				.createRequire(bundle)(
				bundle,
			) as typeof import("../src/embedded-browser");
			const window = new BrowserWindow({
				show: false,
				webPreferences: { sandbox: true },
			});
			const browser = new EmbeddedBrowser(window, () => {});
			const fails = async (operation: Promise<unknown>) => {
				try {
					await operation;
					return "NO ERROR";
				} catch (error) {
					return String(error);
				}
			};
			try {
				await browser.request("first", {
					operation: "navigate",
					url: `${origin}/page`,
				});
				const conflict = await fails(
					browser.request("second", { operation: "read" }),
				);
				browser.release("first");
				const read = (await browser.request("second", {
					operation: "read",
				})) as { elements: { ref: number; label: string }[] };
				const popup = read.elements.find((item) => item.label === "Popup");
				if (!popup) throw new Error("Popup ref missing");
				await browser.request("second", { operation: "click", ref: popup.ref });
				const popupError = browser.status().error;
				const count = BrowserWindow.getAllWindows().length;
				const save = read.elements.find((item) => item.label === "Save report");
				if (!save) throw new Error("Save ref missing");
				const clickController = new AbortController();
				const cancelledClick = fails(
					browser.request(
						"second",
						{ operation: "click", ref: save.ref },
						clickController.signal,
					),
				);
				clickController.abort();
				const clickCancellation = await cancelledClick;
				await new Promise((accept) => setTimeout(accept, 100));
				const afterCancelledClick = (await browser.request("second", {
					operation: "read",
				})) as { text: string };
				const controller = new AbortController();
				const pending = fails(
					browser.request(
						"second",
						{ operation: "navigate", url: `${origin}/slow` },
						controller.signal,
					),
				);
				controller.abort();
				const cancellation = await pending;
				browser.release("second");
				await new Promise((accept) => setTimeout(accept, 100));
				await browser.request("third", {
					operation: "navigate",
					url: `${origin}/page-two`,
				});
				const pendingTakeover = fails(
					browser.request("third", {
						operation: "navigate",
						url: `${origin}/slow`,
					}),
				);
				await browser.command({ operation: "takeover" });
				const takeover = await pendingTakeover;
				const manual = await fails(
					browser.request("third", { operation: "read" }),
				);
				await new Promise((accept) => setTimeout(accept, 100));
				await browser.command({ operation: "resume" });
				const closing = fails(
					browser.request("third", {
						operation: "navigate",
						url: `${origin}/slow`,
					}),
				);
				browser.close();
				return {
					clickCancellation,
					cancelledClickText: afterCancelledClick.text,
					conflict,
					cancellation,
					takeover,
					manual,
					closing: await closing,
					popupError,
					count,
				};
			} finally {
				browser.close();
				window.destroy();
			}
		},
		{ bundle: join(scratch, "embedded-browser-fixture.cjs"), origin },
	);
	assert.match(lifecycle.conflict, /in use/);
	assert.match(lifecycle.clickCancellation, /interrupted|aborted/i);
	assert.ok(
		!lifecycle.cancelledClickText.includes("Saved"),
		"Cancelled click must not run after readiness resolves",
	);
	assert.match(lifecycle.cancellation, /interrupted|ERR_ABORTED/);
	assert.match(lifecycle.takeover, /interrupted|ERR_ABORTED/);
	assert.match(lifecycle.manual, /user has browser control/);
	assert.match(lifecycle.closing, /interrupted|ERR_ABORTED/);
	assert.match(lifecycle.popupError ?? "", /Pop-up blocked/);
	assert.equal(lifecycle.count, 2, "Pop-up must not create another window");
	console.log(
		"PASS: real Chromium task leases, cancellation, takeover, shutdown and blocked popups",
	);
} finally {
	await application.close();
	server.closeAllConnections();
	server.close();
}
console.log(`Embedded browser evidence: ${data}`);

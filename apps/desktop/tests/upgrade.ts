/** Run before and after replacing the installed package, against a local model fixture. */
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { _electron } from "playwright";

const executablePath = process.env.PLINY_DESKTOP_EXECUTABLE;
const data = process.env.PLINY_DESKTOP_UPGRADE_DATA;
const seed = process.argv[2] === "seed";
if (!executablePath || !data)
	throw new Error("Upgrade test needs an isolated install and data path.");
const folder = join(data, "project");
await mkdir(folder, { recursive: true });
let requestBody = "";
const server = createServer(async (request, response) => {
	requestBody = "";
	for await (const chunk of request) requestBody += String(chunk);
	const body = JSON.parse(requestBody);
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const delta of [{ content: "Saved upgrade marker." }, {}])
		response.write(
			`data: ${JSON.stringify({ id: "upgrade", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: "content" in delta ? null : "stop" }] })}\n\n`,
		);
	response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No fixture port");
const env: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([, value]) => value !== undefined),
	),
	PLINY_DESKTOP_DATA: join(data, "state"),
	PLINY_DESKTOP_TEST_PROJECT: folder,
	PLINY_API_KEY: "upgrade-fixture-key",
	PLINY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
	GIT_CEILING_DIRECTORIES: data,
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({
	executablePath,
	args: [],
	env,
	timeout: 40_000,
});
try {
	const page = await application.firstWindow();
	if (seed)
		await page.getByRole("button", { name: "Choose a project folder" }).click();
	else {
		await page
			.getByRole("button", { name: /Remember UPGRADE_SENTINEL/ })
			.click();
		await page
			.getByRole("button", { name: "Improve prompt", exact: true })
			.waitFor();
	}
	const before = await page.locator(".message.user").count();
	await page
		.getByRole("textbox", { name: "Message PlinyCode" })
		.fill(
			seed
				? "Remember UPGRADE_SENTINEL."
				: "Recall the marker saved before upgrading.",
		);
	await page.getByRole("button", { name: /^Send/ }).click();
	await page.waitForFunction(
		(count) => document.querySelectorAll(".message.user").length > count,
		before,
	);
	await page.waitForFunction(
		() => document.querySelector(".badge")?.textContent === "completed",
		undefined,
		{ timeout: 40_000 },
	);
	assert.ok(
		requestBody.includes("UPGRADE_SENTINEL"),
		"The upgraded engine must load the old conversation",
	);
	assert.equal(
		await page.getByLabel("Model", { exact: true }).inputValue(),
		"pliny/auto-free",
	);
	await page.screenshot({
		path: join(data, seed ? "before-upgrade.png" : "after-upgrade.png"),
	});
	console.log(
		seed
			? "PASS: old installed version saved a conversation"
			: "PASS: upgraded installed version resumed the old engine conversation",
	);
} catch (error) {
	const page = application.windows()[0];
	if (page) {
		console.error(
			"Upgrade fixture state:",
			await page.locator('.badge, [role="alert"]').allTextContents(),
		);
		await page
			.screenshot({ path: join(data, "upgrade-failure.png") })
			.catch(() => {});
	}
	throw error;
} finally {
	await application.close();
	server.closeAllConnections();
	server.close();
}

/** Real Electron draft switching and delayed native-dialog regression tests. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(root, "../../ai_output");
await mkdir(scratch, { recursive: true });
const data = await mkdtemp(join(scratch, "desktop-drafts-"));
const project = join(data, "project");
await mkdir(project);
const env: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	),
	PLINY_DESKTOP_DATA: join(data, "state"),
	PLINY_DESKTOP_TEST_PROJECT: project,
	PLINY_API_KEY: "fixture-draft-key",
	GIT_CEILING_DIRECTORIES: data,
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({
	executablePath: createRequire(import.meta.url)("electron"),
	args: [root, `--user-data-dir=${join(data, "profile")}`],
	env,
	timeout: 40_000,
});
try {
	const page = await application.firstWindow();
	await page.getByRole("button", { name: /Add project/ }).click();
	await page.getByRole("button", { name: "Add folders…" }).click();
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	const composer = page.getByRole("textbox", { name: "Message PlinyCode" });
	await composer.fill("Draft A\nKeep my details.");
	await page.getByTitle("New chat in project").click();
	await page.waitForFunction(
		() => document.querySelectorAll(".chat-link").length === 2,
	);
	assert.equal(
		await composer.inputValue(),
		"",
		"New chat must not inherit another chat's draft",
	);
	await composer.fill("Draft B");
	await page.locator(".chat-link").nth(1).click();
	assert.equal(
		await composer.inputValue(),
		"Draft A\nKeep my details.",
		"Switching chats must preserve unsent prompts",
	);
	await application.evaluate(({ dialog }) => {
		dialog.showOpenDialog = () =>
			new Promise((accept) => {
				(
					globalThis as typeof globalThis & { releaseAttachment?: () => void }
				).releaseAttachment = () =>
					accept({ canceled: false, filePaths: ["fixture-selected-file.txt"] });
			});
	});
	await page.getByRole("button", { name: "Attach files", exact: true }).click();
	await application.evaluate(async () => {
		while (
			!(globalThis as typeof globalThis & { releaseAttachment?: () => void })
				.releaseAttachment
		)
			await new Promise((accept) => setTimeout(accept, 10));
	});
	await page.locator(".chat-link").nth(0).click();
	await application.evaluate(() =>
		(
			globalThis as typeof globalThis & { releaseAttachment?: () => void }
		).releaseAttachment?.(),
	);
	await page.locator(".chat-link").nth(1).click();
	await page.waitForFunction(() =>
		(
			document.querySelector(
				'textarea[aria-label="Message PlinyCode"]',
			) as HTMLTextAreaElement
		)?.value.includes("fixture-selected-file.txt"),
	);
	assert.ok(
		(await composer.inputValue()).startsWith("Draft A\nKeep my details."),
	);
	await page.locator(".chat-link").nth(0).click();
	assert.equal(
		await composer.inputValue(),
		"Draft B",
		"Late attachments must not overwrite another chat's draft",
	);
	await page.screenshot({ path: join(data, "drafts.png") });
	console.log(
		"PASS: isolated per-chat drafts survive switching and delayed file selection",
	);
} finally {
	await application.close();
}

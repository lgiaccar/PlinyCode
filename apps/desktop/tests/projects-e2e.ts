/** Project lifecycle exercised through an isolated Electron profile. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(root, "../../ai_output");
await mkdir(scratch, { recursive: true });
const data = await mkdtemp(join(scratch, "desktop-project-management-"));
const folders = [
	join(data, "first"),
	join(data, "second"),
	join(data, "third"),
];
for (const folder of folders) {
	await mkdir(folder);
	await writeFile(join(folder, "keep.txt"), "project file");
}
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	),
);
Object.assign(env, {
	PLINY_DESKTOP_DATA: join(data, "state"),
	PLINY_API_KEY: "fixture-project-key",
	GIT_CEILING_DIRECTORIES: data,
});
delete env.ELECTRON_RUN_AS_NODE;
delete env.PLINY_DESKTOP_TEST_PROJECT;
const packaged = process.env.PLINY_DESKTOP_EXECUTABLE;
const launch = () =>
	_electron.launch({
		executablePath: packaged ?? createRequire(import.meta.url)("electron"),
		args: [
			...(packaged ? [] : [root]),
			`--user-data-dir=${join(data, "profile")}`,
		],
		env,
		timeout: 40_000,
	});
let application = await launch();
try {
	let page = await application.firstWindow();
	const snapshot = () =>
		page.evaluate(
			async () => (await window.plinycode.invoke({ type: "snapshot" })).state,
		);
	const choose = (paths: string[]) =>
		application.evaluate(({ dialog }, paths) => {
			dialog.showOpenDialog = async () => ({
				canceled: !paths.length,
				filePaths: paths,
			});
		}, paths);
	await page.getByRole("button", { name: /Add project/ }).click();
	assert.equal(
		await page
			.getByRole("button", { name: "Create project", exact: true })
			.isEnabled(),
		false,
	);
	await page
		.getByLabel("Project name", { exact: true })
		.fill("Cancelled workspace");
	await choose([]);
	await page.getByRole("button", { name: "Add folders…" }).click();
	assert.equal((await snapshot()).projects.length, 0);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	assert.equal((await snapshot()).projects.length, 0);

	await page.getByRole("button", { name: /Add project/ }).click();
	await page.getByLabel("Project name", { exact: true }).fill("My workspace");
	await choose(folders.slice(0, 2));
	await page.getByRole("button", { name: "Add folders…" }).click();
	await page.screenshot({ path: join(data, "new-project.png") });
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	let state = await snapshot();
	const projectId = state.projects[0].id,
		chatId = state.tasks[0].id;
	assert.equal(state.projects[0].name, "My workspace");
	assert.deepEqual(state.projects[0].folders, folders.slice(0, 2));
	await page
		.getByRole("textbox", { name: "Message PlinyCode" })
		.fill("Preserve my unsent draft");

	// A fixture token stays with the original repository when the primary root changes.
	await page.evaluate(
		(id) =>
			window.plinycode.invoke({
				type: "savePrRepository",
				id,
				repository: {
					provider: "github",
					apiUrl: "https://api.github.com",
					owner: "fixture",
					repository: "fixture",
					apiVersion: "7.0",
				},
				token: "project-fixture-token",
			}),
		projectId,
	);
	await page.getByTitle("Project settings").click();
	await page
		.getByRole("button", { name: `Remove ${folders[0]}`, exact: true })
		.click();
	await choose([folders[2]]);
	await page.getByRole("button", { name: "Add folders…" }).click();
	await page
		.getByLabel("Project name", { exact: true })
		.fill("Renamed workspace");
	await page.screenshot({ path: join(data, "edit-project.png") });
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	state = await snapshot();
	assert.deepEqual(state.projects[0].folders, folders.slice(1));
	assert.deepEqual(state.tasks[0].folders, folders.slice(0, 2));
	assert.equal(state.tasks[0].sourceProject?.path, folders[0]);
	const secretFile = join(data, "state", "mcp-secrets.json");
	const secrets = JSON.parse(await readFile(secretFile, "utf8"));
	assert.equal(secrets[`pr:${projectId}`], undefined);
	assert.ok(secrets[`pr:${state.tasks[0].sourceProject?.id}`]);
	assert.equal(JSON.stringify(state).includes("project-fixture-token"), false);

	await page.getByTitle("New chat in Renamed workspace").click();
	await page.waitForFunction(
		() => document.querySelectorAll(".chat-link").length === 2,
	);
	assert.deepEqual((await snapshot()).tasks[0].folders, folders.slice(1));
	await page.locator(".chat-link").nth(1).click();
	assert.equal(
		await page.getByRole("textbox", { name: "Message PlinyCode" }).inputValue(),
		"Preserve my unsent draft",
	);

	await page.getByTitle("Project settings").click();
	await page
		.getByRole("button", { name: "Delete project…", exact: true })
		.click();
	assert.equal(
		await page.getByLabel("Also delete saved chats").isChecked(),
		false,
	);
	await page
		.getByRole("button", { name: "Delete project, keep chats", exact: true })
		.click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	assert.equal(await page.locator(".active-projects .project").count(), 0);
	assert.equal(await page.locator(".archived-projects .chat-link").count(), 2);
	await application.close();
	application = await launch();
	page = await application.firstWindow();
	await page.locator(".archived-projects .chat-link").nth(1).click();
	assert.equal(
		await page.getByRole("textbox", { name: "Message PlinyCode" }).inputValue(),
		"Preserve my unsent draft",
	);
	state = await snapshot();
	assert.equal(state.projects[0].archived, true);
	assert.equal(
		state.tasks.find((task) => task.id === chatId)?.projectId,
		projectId,
	);
	await page.getByTitle("Project settings").click();
	await page
		.getByRole("button", { name: "Restore project", exact: true })
		.click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	assert.equal(await page.locator(".active-projects .project").count(), 1);

	await page.getByTitle("Project settings").click();
	await page
		.getByRole("button", { name: "Delete project…", exact: true })
		.click();
	await page.getByLabel("Also delete saved chats").check();
	await page
		.getByRole("button", { name: "Delete project and chats", exact: true })
		.click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	state = await snapshot();
	assert.equal(state.projects.length, 0);
	assert.equal(state.tasks.length, 0);
	assert.deepEqual(JSON.parse(await readFile(secretFile, "utf8")), {});
	assert.deepEqual(
		await page.evaluate(
			async () =>
				(await window.plinycode.invoke({ type: "loadDrafts" })).drafts,
		),
		{},
	);
	for (const folder of folders)
		assert.equal(
			await readFile(join(folder, "keep.txt"), "utf8"),
			"project file",
		);
	await assert.rejects(stat(join(data, "state", "tasks", chatId)));
	await application.close();
	application = await launch();
	page = await application.firstWindow();
	await page.getByRole("button", { name: /Add project/ }).waitFor();
	assert.equal((await snapshot()).tasks.length, 0);
	assert.equal((await snapshot()).projects.length, 0);
	console.log(`Project lifecycle screenshots: ${data}`);
	console.log(
		"PASS: named multi-folder creation, cancellation, primary removal, old chat roots, archive/restore, persisted drafts and opt-in deletion",
	);
} finally {
	await application.close();
}

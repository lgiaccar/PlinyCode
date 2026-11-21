import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { actionSchema } from "../src/contracts";
import { git, prepareWorktree } from "../src/git";
import { TaskManager } from "../src/manager";
import { DesktopStore } from "../src/store";

const scratchRoot = resolve(import.meta.dir, "../../../ai_output");
async function scratch() {
	await mkdir(scratchRoot, { recursive: true });
	return mkdtemp(join(scratchRoot, "desktop-test-"));
}
test("existing installations enable update checks once and retain an explicit opt-out", async () => {
	const dir = await scratch();
	const file = join(dir, "state.json");
	const original = new DesktopStore(file).state;
	await writeFile(
		file,
		JSON.stringify({
			...original,
			settings: {
				model: original.settings.model,
				permissions: original.settings.permissions,
				subagents: original.settings.subagents,
			},
		}),
	);
	const migrated = new DesktopStore(file);
	expect(migrated.state.settings.autoCheckUpdates).toBe(true);
	migrated.state.settings.autoCheckUpdates = false;
	migrated.save();
	expect(new DesktopStore(file).state.settings.autoCheckUpdates).toBe(false);
});
test("task defaults are copied; running tasks reopen as interrupted without replay", async () => {
	const dir = await scratch();
	try {
		const store = new DesktopStore(join(dir, "state.json"));
		const manager = new TaskManager(
			store,
			dir,
			process.execPath,
			"unused",
			() => {},
		);
		const project = await manager.addProject(dir),
			task = manager.createTask(project.id, false);
		store.state.settings.permissions.commands = true;
		expect(task.permissions.commands).toBe(false);
		task.status = "running";
		task.pullRequest = { status: "creating", target: "main" };
		task.input = { id: crypto.randomUUID(), kind: "approval", text: "Run?" };
		store.save();
		const reopened = new DesktopStore(join(dir, "state.json"));
		expect(reopened.state.tasks[0].status).toBe("interrupted");
		expect(reopened.state.tasks[0].input).toBeUndefined();
		expect(reopened.state.tasks[0].permissions.commands).toBe(false);
		expect(reopened.state.tasks[0].pullRequest?.status).toBe("uncertain");
		reopened.state.tasks[0].pullRequest = {
			status: "publishing",
			target: "main",
		};
		reopened.save();
		expect(
			new DesktopStore(join(dir, "state.json")).state.tasks[0].pullRequest
				?.status,
		).toBe("failed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("IPC validates identifiers and settings; corrupt history is preserved", async () => {
	expect(
		actionSchema.safeParse({ type: "send", id: "../other", prompt: "run" })
			.success,
	).toBe(false);
	expect(
		actionSchema.safeParse({
			type: "projectSettings",
			id: crypto.randomUUID(),
			remote: "--upload-pack=oops",
			base: "",
			target: "",
		}).success,
	).toBe(false);
	const dir = await scratch();
	try {
		const file = join(dir, "state.json");
		await writeFile(file, "broken history");
		expect(() => new DesktopStore(file)).toThrow();
		expect(await readFile(file, "utf8")).toBe("broken history");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("worktrees use the freshly fetched remote default, leaving local changes untouched", async () => {
	const dir = await scratch();
	try {
		const origin = join(dir, "origin"),
			checkout = join(dir, "checkout");
		await mkdir(origin);
		await mkdir(checkout);
		await git(origin, ["init", "-b", "stage"]);
		await git(origin, ["config", "user.email", "fixture@example.invalid"]);
		await git(origin, ["config", "user.name", "Fixture"]);
		await writeFile(join(origin, "file.txt"), "first");
		await git(origin, ["add", "."]);
		await git(origin, ["commit", "-m", "first"]);
		await git(dir, ["clone", origin, checkout]);
		await writeFile(join(checkout, "file.txt"), "local dirty change");
		await writeFile(join(origin, "file.txt"), "remote update");
		await git(origin, ["commit", "-am", "second"]);
		const manager = new TaskManager(
			new DesktopStore(join(dir, "state.json")),
			dir,
			process.execPath,
			"unused",
			() => {},
		);
		const project = await manager.addProject(checkout),
			task = manager.createTask(project.id, true);
		const result = await prepareWorktree(
			project,
			task,
			join(dir, "data"),
			false,
			new AbortController().signal,
		);
		expect(result.baseBranch).toBe("stage");
		expect(await readFile(join(result.cwd, "file.txt"), "utf8")).toBe(
			"remote update",
		);
		expect(await readFile(join(checkout, "file.txt"), "utf8")).toBe(
			"local dirty change",
		);
		expect(result.baseCommit).toBe(await git(origin, ["rev-parse", "HEAD"]));
		await git(checkout, ["remote", "set-url", "origin", join(dir, "missing")]);
		const offline = manager.createTask(project.id, true);
		await expect(
			prepareWorktree(
				project,
				offline,
				join(dir, "data"),
				false,
				new AbortController().signal,
			),
		).rejects.toThrow();
		const cached = await prepareWorktree(
			project,
			offline,
			join(dir, "data"),
			true,
			new AbortController().signal,
		);
		expect(cached.baseCommit).toBe(result.baseCommit);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

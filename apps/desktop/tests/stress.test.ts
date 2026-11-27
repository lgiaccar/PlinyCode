import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { git, overlaps, prepareWorktree } from "../src/git";
import { TaskManager } from "../src/manager";
import { DesktopStore } from "../src/store";

async function fixture() {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	const directory = await mkdtemp(join(scratch, "desktop-stress-"));
	const manager = new TaskManager(
		new DesktopStore(join(directory, "state.json")),
		directory,
		process.execPath,
		"unused",
		() => {},
		async () => "fixture",
	);
	return { directory, manager };
}

test("folder leases include filesystem roots without confusing sibling prefixes", () => {
	const root = parse(process.cwd()).root;
	expect(overlaps(root, join(root, "project", "child"))).toBe(true);
	expect(overlaps(join(root, "project"), root)).toBe(true);
	expect(overlaps(join(root, "project"), join(root, "project-other"))).toBe(
		false,
	);
});

test("prepared worktrees respect existing folder leases in either start order", async () => {
	const { directory, manager } = await fixture();
	const project = await manager.addProject(directory);
	const held = manager.createTask(project.id, false);
	const worktree = manager.createTask(project.id, false);
	worktree.worktree = true;
	worktree.cwd = directory;
	manager.running.set(held.id, {
		controller: new AbortController(),
		folder: directory,
		folders: [directory],
	});
	try {
		manager.send(worktree.id, "Do not write into a leased worktree");
		expect(worktree.status).toBe("queued");
	} finally {
		await manager.close();
	}
});

test("cached default branch works in init-plus-remote repositories and follows a changed remote default", async () => {
	const { directory, manager } = await fixture();
	const origin = join(directory, "origin"),
		checkout = join(directory, "checkout");
	await mkdir(origin);
	await mkdir(checkout);
	await git(origin, ["init", "-b", "main"]);
	await git(origin, ["config", "user.name", "Fixture"]);
	await git(origin, ["config", "user.email", "fixture@example.invalid"]);
	await writeFile(join(origin, "test.txt"), "base");
	await git(origin, ["add", "."]);
	await git(origin, ["commit", "-m", "initial"]);
	await git(checkout, ["init", "-b", "main"]);
	await git(checkout, ["remote", "add", "origin", origin]);
	const project = await manager.addProject(checkout);
	const prepare = (cached: boolean) =>
		prepareWorktree(
			project,
			manager.createTask(project.id, true),
			join(directory, "data"),
			cached,
			new AbortController().signal,
		);
	const first = await prepare(false);
	await git(checkout, [
		"remote",
		"set-url",
		"origin",
		join(directory, "offline"),
	]);
	expect((await prepare(true)).baseCommit).toBe(first.baseCommit);
	await git(checkout, ["remote", "set-url", "origin", origin]);
	await git(origin, ["checkout", "-b", "next"]);
	await writeFile(join(origin, "test.txt"), "new default");
	await git(origin, ["commit", "-am", "next"]);
	const next = await prepare(false);
	await git(checkout, [
		"remote",
		"set-url",
		"origin",
		join(directory, "offline"),
	]);
	const cached = await prepare(true);
	expect(cached.baseBranch).toBe("next");
	expect(cached.baseCommit).toBe(next.baseCommit);
}, 60_000);

test("three bursts of mixed folder/worktree tasks serialize writes, cancel queued work and drain cleanly", async () => {
	const { directory } = await fixture();
	const worker = join(directory, "lease-worker.js");
	await writeFile(
		worker,
		`
import { createInterface } from 'node:readline';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
createInterface({input:process.stdin}).once('line', async line => {
 const {input}=JSON.parse(line); const lock=join(input.task.cwd, 'exclusive-writer');
 try {
  await writeFile(lock,input.task.id,{flag:'wx'});
  await new Promise(resolve=>setTimeout(resolve,40));
  await unlink(lock);
  process.stdout.write(JSON.stringify({type:'done',status:'completed',text:'exclusive write completed'})+'\\n');
 } catch(error) { process.stdout.write(JSON.stringify({type:'done',status:'failed',error:String(error)})+'\\n'); }
}); setInterval(()=>{},1000);
`,
	);
	const manager = new TaskManager(
		new DesktopStore(join(directory, "burst-state.json")),
		directory,
		process.execPath,
		worker,
		() => {},
		async () => "fixture",
	);
	try {
		const tasks = [];
		for (let folder = 0; folder < 4; folder++) {
			const path = join(directory, `folder-${folder}`);
			await mkdir(path);
			const project = await manager.addProject(path);
			for (let i = 0; i < 6; i++) {
				const task = manager.createTask(project.id, false);
				task.cwd = path;
				task.worktree = i % 2 === 1;
				tasks.push(task);
			}
		}
		for (let wave = 0; wave < 3; wave++) {
			for (const task of tasks) manager.send(task.id, `wave ${wave}`);
			const cancelled = tasks.filter(
				(task, index) => index % 6 === 5 && task.status === "queued",
			);
			await Promise.all(cancelled.map((task) => manager.cancel(task.id)));
			const deadline = Date.now() + 45_000;
			while (
				tasks.some(
					(task) => !["completed", "cancelled", "failed"].includes(task.status),
				)
			) {
				if (Date.now() > deadline) throw new Error("Burst failed to drain");
				await new Promise((accept) => setTimeout(accept, 20));
			}
			expect(
				tasks
					.filter((task) => task.status === "failed")
					.map((task) => task.error),
			).toEqual([]);
			expect(tasks.filter((task) => task.status === "completed")).toHaveLength(
				20,
			);
			expect(manager.running.size).toBe(0);
		}
	} finally {
		await manager.close();
	}
}, 120_000);

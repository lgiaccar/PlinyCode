import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TaskManager } from "../src/manager";
import { DesktopStore } from "../src/store";

async function until(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 15_000;
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new Error("Lifecycle condition timed out.");
		await new Promise((accept) => setTimeout(accept, 40));
	}
}
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("independent folders run concurrently; cancellation and app exit kill owned descendants", async () => {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	const directory = await mkdtemp(join(scratch, "desktop-lifecycle-"));
	const firstFolder = join(directory, "first"),
		otherFolder = join(directory, "other");
	await mkdir(firstFolder);
	await mkdir(otherFolder);
	const worker = join(directory, "fixture-worker.ts");
	await writeFile(
		worker,
		`
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
createInterface({ input: process.stdin }).on("line", (line) => {
 const command = JSON.parse(line);
 if (command.type !== "run") return;
 const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
 writeFileSync(join(command.input.task.cwd, command.input.task.id + ".pid"), String(child.pid));
});
setInterval(() => {}, 1000);
`,
	);
	const store = new DesktopStore(join(directory, "state.json"));
	const manager = new TaskManager(
		store,
		directory,
		process.execPath,
		worker,
		() => {},
		async () => "fixture-key",
	);
	const firstProject = await manager.addProject(firstFolder),
		otherProject = await manager.addProject(otherFolder);
	const first = manager.createTask(firstProject.id, false),
		queued = manager.createTask(firstProject.id, false),
		independent = manager.createTask(otherProject.id, false);
	const pid = async (folder: string, id: string) =>
		Number(await readFile(join(folder, `${id}.pid`), "utf8").catch(() => "0"));
	try {
		manager.send(first.id, "hold first");
		manager.send(queued.id, "wait first");
		manager.send(independent.id, "hold other");
		await until(
			async () =>
				!!(await pid(firstFolder, first.id)) &&
				!!(await pid(otherFolder, independent.id)),
		);
		expect(queued.status).toBe("queued");
		expect(first.status).toBe("running");
		expect(independent.status).toBe("running");
		const firstPid = await pid(firstFolder, first.id),
			independentPid = await pid(otherFolder, independent.id);
		await manager.cancel(first.id);
		expect(alive(firstPid)).toBe(false);
		expect(alive(independentPid)).toBe(true);
		await until(async () => !!(await pid(firstFolder, queued.id)));
		const queuedPid = await pid(firstFolder, queued.id);
		await manager.close();
		expect(alive(queuedPid)).toBe(false);
		expect(alive(independentPid)).toBe(false);
		expect(manager.running.size).toBe(0);
		expect(
			new DesktopStore(store.file).state.tasks.every(
				(task) => task.status === "cancelled",
			),
		).toBe(true);
	} finally {
		await manager.close();
	}
}, 30_000);

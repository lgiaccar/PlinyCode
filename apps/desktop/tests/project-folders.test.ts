import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { git, taskDiff } from "../src/git";
import { TaskManager } from "../src/manager";
import {
	projectFolders,
	taskFolders,
	workspacePrompt,
} from "../src/project-folders";
import { DesktopStore } from "../src/store";

async function until(check: () => boolean) {
	const deadline = Date.now() + 15_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Multi-folder task timed out.");
		await Bun.sleep(30);
	}
}

async function fixture() {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	const data = await mkdtemp(join(scratch, "desktop-folders-"));
	const folders = [
		join(data, "first"),
		join(data, "second"),
		join(data, "independent"),
	];
	for (const folder of folders) await mkdir(folder);
	const worker = join(data, "worker.ts");
	await writeFile(
		worker,
		`
import { createInterface } from "node:readline";
createInterface({input: process.stdin}).on("line", line => {
 const message = JSON.parse(line);
 if (message.type !== "run") return;
 if (message.input.prompt === "hold") return;
 process.stdout.write(JSON.stringify({type:"done", status:"completed", text:JSON.stringify(message.input.task.folders)})+"\\n");
}); setInterval(()=>{},1000);
`,
	);
	await writeFile(
		join(data, "command-worker.js"),
		`import ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../src/command-worker.ts")).href)};`,
	);
	const store = new DesktopStore(join(data, "state.json"));
	const manager = new TaskManager(
		store,
		data,
		process.execPath,
		worker,
		() => {},
		async () => "fixture-key",
	);
	return { manager, store, folders, data };
}

test("project folder selection persists, deduplicates, and never retargets old chats", async () => {
	const { manager, store, folders } = await fixture();
	try {
		const project = await manager.addProject(folders[0]);
		const old = manager.createTask(project.id, false);
		delete old.folders; // saved pre-feature chat
		await manager.updateProject(project.id, {
			...project,
			name: "Whole project",
			folders: [folders[0], folders[1], folders[1]],
		});
		const shared = manager.createTask(project.id, true);
		expect(shared.worktree).toBe(false);
		expect(taskFolders(old, project)).toEqual([folders[0]]);
		expect(shared.folders).toEqual(folders.slice(0, 2));
		await manager.updateProject(project.id, {
			...project,
			folders: [folders[0]],
		});
		expect(shared.folders).toEqual(folders.slice(0, 2));
		expect(
			new DesktopStore(store.file).state.tasks.find(
				(task) => task.id === shared.id,
			)?.folders,
		).toEqual(folders.slice(0, 2));
		expect(project.name).toBe("Whole project");
		await expect(
			manager.updateProject(project.id, { ...project, folders: [folders[1]] }),
		).rejects.toThrow("original folder first");
		await expect(manager.addProject([])).rejects.toThrow("Select between");
		await expect(
			manager.updateProject(project.id, {
				...project,
				folders: [folders[0], join(folders[0], "missing")],
			}),
		).rejects.toThrow();
		expect(projectFolders(project)).toEqual([folders[0]]);
	} finally {
		await manager.close();
	}
});

test("shared secondary roots serialize tasks while unrelated folders run concurrently", async () => {
	const { manager, folders } = await fixture();
	try {
		const project = await manager.addProject(folders.slice(0, 2));
		const other = await manager.addProject(folders[1]);
		const independent = await manager.addProject(folders[2]);
		const first = manager.createTask(project.id, false);
		const second = manager.createTask(other.id, false);
		const third = manager.createTask(independent.id, false);
		manager.send(first.id, "hold");
		manager.send(second.id, "wait");
		manager.send(third.id, "independent");
		await until(
			() => first.status === "running" && third.status === "completed",
		);
		expect(second.status).toBe("queued");
		await expect(
			manager.updateProject(project.id, { ...project, folders: [folders[0]] }),
		).rejects.toThrow("Stop project tasks");
		await manager.cancel(first.id);
		await until(() => second.status === "completed");
		manager.send(first.id, "inspect roots");
		await until(() => first.status === "completed");
		expect(first.messages.at(-1)?.text).toBe(
			JSON.stringify(folders.slice(0, 2)),
		);
		expect(workspacePrompt(first)).toContain(
			JSON.stringify(folders.slice(0, 2)),
		);
	} finally {
		await manager.close();
	}
}, 30_000);

test("background commands retain every folder lease and allow their own follow-up", async () => {
	const { manager, folders } = await fixture();
	try {
		const project = await manager.addProject(folders.slice(0, 2));
		const other = await manager.addProject(folders[1]);
		const first = manager.createTask(project.id, false);
		const second = manager.createTask(other.id, false);
		first.cwd = folders[0];
		const command = manager.commands.start(
			first,
			process.platform === "win32"
				? "Write-Output ready; Start-Sleep -Seconds 90"
				: "echo ready; sleep 90",
			[],
		);
		await until(() => command.output.includes("ready"));
		await expect(
			manager.updateProject(project.id, { ...project, folders: [folders[0]] }),
		).rejects.toThrow("background commands");
		manager.send(second.id, "wait for second folder");
		manager.send(first.id, "follow up");
		await until(() => first.status === "completed");
		expect(second.status).toBe("queued");
		await manager.commands.stop(first.id, command.id);
		await until(() => second.status === "completed");
	} finally {
		await manager.close();
	}
}, 30_000);

test("unavailable secondary folder fails before launching a worker", async () => {
	const { manager, folders } = await fixture();
	try {
		const project = await manager.addProject(folders.slice(0, 2));
		const task = manager.createTask(project.id, false);
		await rename(folders[1], `${folders[1]}-moved`);
		manager.send(task.id, "inspect roots");
		await until(() => task.status === "failed");
		expect(task.messages.some((message) => message.role === "assistant")).toBe(
			false,
		);
	} finally {
		await manager.close();
	}
});

test("diff review includes changes from each Git root", async () => {
	const { manager, folders } = await fixture();
	try {
		for (const [index, folder] of folders.slice(0, 2).entries()) {
			await git(folder, ["init"]);
			await writeFile(join(folder, "file.txt"), "original\n");
			await git(folder, ["add", "file.txt"]);
			await git(folder, [
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"-m",
				"fixture",
			]);
			await writeFile(join(folder, "file.txt"), `updated-${index}\n`);
		}
		const project = await manager.addProject(folders.slice(0, 2));
		const task = manager.createTask(project.id, true);
		const diff = await taskDiff(task);
		for (const [index, folder] of folders.slice(0, 2).entries()) {
			expect(diff).toContain(`Folder: ${folder}`);
			expect(diff).toContain(`+updated-${index}`);
			expect(await readFile(join(folder, "file.txt"), "utf8")).toBe(
				`updated-${index}\n`,
			);
		}
	} finally {
		await manager.close();
	}
}, 30_000);

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { BackgroundCommands } from "../src/commands";
import { freshState, type Task } from "../src/contracts";
import { stopTree, TaskManager } from "../src/manager";
import { DesktopStore } from "../src/store";

async function until(check: () => boolean) {
	const until = Date.now() + 15_000;
	while (!check()) {
		if (Date.now() > until) throw new Error("Command test timed out.");
		await new Promise((accept) => setTimeout(accept, 30));
	}
}
test("a lost host pipe stops a command worker and its shell descendant", async () => {
	const child = spawn(
		process.execPath,
		[resolve(import.meta.dir, "../src/command-worker.ts")],
		{
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const lines = createInterface({ input: child.stdout });
	let output = "";
	lines.on("line", (line) => {
		const event = JSON.parse(line);
		if (event.text) output += event.text;
	});
	child.stderr.resume();
	child.stdin.on("error", () => {});
	child.stdin.write(
		`${JSON.stringify({ command: process.platform === "win32" ? "Write-Output $PID; Start-Sleep -Seconds 90" : "echo $$; sleep 90", cwd: resolve(import.meta.dir), secrets: [] })}\n`,
	);
	try {
		await until(() => /\d+\r?\n/.test(output));
		const shellPid = Number(output.trim());
		expect(shellPid).toBeGreaterThan(0);
		child.stdin.end();
		await until(() => child.exitCode !== null || child.signalCode !== null);
		await until(() => {
			try {
				process.kill(shellPid, 0);
				return false;
			} catch {
				return true;
			}
		});
	} finally {
		await stopTree(child);
		lines.close();
	}
}, 25_000);

test("background folder lease blocks other chats but permits its own follow-up", async () => {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	const directory = await mkdtemp(join(scratch, "desktop-command-lease-"));
	await writeFile(
		join(directory, "command-worker.js"),
		`import ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../src/command-worker.ts")).href)};`,
	);
	const worker = join(directory, "fixture.js");
	await writeFile(
		worker,
		'import { createInterface } from "node:readline"; createInterface({input:process.stdin}).on("line", line => { if(JSON.parse(line).type === "run") process.stdout.write(JSON.stringify({type:"done",status:"completed",text:"fixture"})+"\\n"); }); setInterval(()=>{},1000);',
	);
	const manager = new TaskManager(
		new DesktopStore(join(directory, "state.json")),
		directory,
		process.execPath,
		worker,
		() => {},
		async () => "fixture-token",
	);
	const project = await manager.addProject(directory),
		first = manager.createTask(project.id, false),
		second = manager.createTask(project.id, false);
	first.cwd = directory;
	try {
		const command = manager.commands.start(
			first,
			process.platform === "win32"
				? "Write-Output ready; Start-Sleep -Seconds 90"
				: "echo ready; sleep 90",
			[],
		);
		await until(() => command.output.includes("ready"));
		manager.send(second.id, "Wait for the build folder");
		expect(second.status).toBe("queued");
		manager.send(first.id, "Follow up while my build runs");
		await until(() => first.status === "completed");
		expect(command.status).toBe("running");
		expect(second.status).toBe("queued");
		await manager.commands.stop(first.id, command.id);
		await until(() => second.status === "completed");
	} finally {
		await manager.close();
	}
}, 30_000);
test("background commands redact output, enforce task ownership, stop on close and never replay", async () => {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	const directory = await mkdtemp(join(scratch, "desktop-command-test-"));
	const store = new DesktopStore(join(directory, "state.json"));
	const commands = new BackgroundCommands(
		store.state,
		process.execPath,
		resolve(import.meta.dir, "../src/command-worker.ts"),
		() => store.save(),
		stopTree,
	);
	const task: Task = {
		id: crypto.randomUUID(),
		projectId: crypto.randomUUID(),
		title: "fixture",
		model: "pliny/auto-free",
		permissions: freshState().settings.permissions,
		status: "idle",
		messages: [],
		createdAt: 0,
		updatedAt: 0,
		worktree: false,
		cwd: directory,
	};
	const secret = "fixture-command-secret";
	try {
		const command = commands.start(
			task,
			process.platform === "win32"
				? `Write-Output '${secret} ready'; Start-Sleep -Seconds 90`
				: `echo '${secret} ready'; sleep 90`,
			[secret],
		);
		await until(() => command.output.includes("ready"));
		expect(command.output).toContain("[REDACTED]");
		expect(command.output).not.toContain(secret);
		expect(command.command).not.toContain(secret);
		await expect(commands.stop("another-task", command.id)).rejects.toThrow(
			"Command not found",
		);
		expect(command.status).toBe("running");
		const reopened = new DesktopStore(store.file);
		expect(reopened.state.commands?.[0].status).toBe("interrupted");
		await commands.close();
		expect(command.status).toBe("stopped");
		const failed = commands.start(task, "exit 7", []);
		await until(() => failed.status !== "running");
		expect(failed.status).toBe("failed");
		expect(failed.exitCode).toBe(7);
	} finally {
		await commands.close();
	}
}, 30_000);

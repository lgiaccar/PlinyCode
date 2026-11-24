import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MessageWithMetadata } from "@plinycode/llms";
import { historyBefore, restartSeed } from "../src/history";
import { TaskManager } from "../src/manager";
import { DesktopStore } from "../src/store";

async function fixture() {
	const root = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(root, { recursive: true });
	const directory = await mkdtemp(join(root, "desktop-history-"));
	const store = new DesktopStore(join(directory, "state.json"));
	const manager = new TaskManager(
		store,
		directory,
		process.execPath,
		"unused",
		() => {},
		async () => "fixture-secret",
	);
	const project = await manager.addProject(directory);
	const task = manager.createTask(project.id, false);
	task.cwd = directory;
	const add = (text: string) => ({
		id: randomUUID(),
		role: "user" as const,
		text,
		at: Date.now(),
	});
	task.messages = [add("first"), add("second"), add("discarded")];
	const taskDir = join(directory, "tasks", task.id);
	return { manager, task, taskDir, store };
}

test("legacy restart preserves tool history before the selected prompt and rejects ambiguous/compacted history", async () => {
	const { task, taskDir } = await fixture();
	const history: MessageWithMetadata[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: '<user_input mode="act">first</user_input>' },
			],
		},
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "call", name: "read_files", input: {} },
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					name: "read_files",
					tool_use_id: "call",
					content: "file content",
				},
			],
		},
		{ role: "assistant", content: "answer" },
		{
			role: "user",
			content: [
				{ type: "text", text: '<user_input mode="act">second</user_input>' },
			],
		},
		{ role: "assistant", content: "later answer" },
	];
	const folder = join(taskDir, "sessions", task.id);
	await mkdir(folder, { recursive: true });
	const path = join(folder, `${task.id}.messages.json`);
	await writeFile(path, JSON.stringify({ messages: history }));
	expect(await historyBefore(taskDir, task, task.messages[1].id)).toEqual(
		history.slice(0, 4),
	);
	await writeFile(path, JSON.stringify({ messages: [...history, history[4]] }));
	await expect(
		historyBefore(taskDir, task, task.messages[1].id),
	).rejects.toThrow("cannot be located safely");
	await writeFile(
		path,
		JSON.stringify({ messages: [{ role: "user", content: "compacted" }] }),
	);
	await expect(
		historyBefore(taskDir, task, task.messages[1].id),
	).rejects.toThrow("cannot be located safely");
	expect(await historyBefore(taskDir, task, task.messages[0].id)).toEqual([]);
});

test("restart uses exact snapshots, archives the original, persists a new session and blocks active work", async () => {
	const { manager, task, taskDir, store } = await fixture();
	await mkdir(join(taskDir, "turns"), { recursive: true });
	const history = [
		{ role: "user", content: "first fixture-secret" },
		{ role: "assistant", content: "answer" },
	];
	await writeFile(
		join(taskDir, "turns", `${task.messages[1].id}.json`),
		JSON.stringify(history),
	);
	const original = structuredClone(task.messages);
	let sent = "";
	manager.send = (_id, prompt) => {
		sent = prompt;
		manager.changed();
	};
	task.status = "running";
	await expect(
		manager.restartFrom(task.id, task.messages[1].id, "edited"),
	).rejects.toThrow("Stop this task");
	task.status = "completed";
	store.state.commands = [
		{
			id: randomUUID(),
			taskId: task.id,
			command: "test",
			cwd: task.cwd!,
			status: "running",
			output: "",
			startedAt: Date.now(),
		},
	];
	await expect(
		manager.restartFrom(task.id, task.messages[1].id, "edited"),
	).rejects.toThrow("Stop this task");
	store.state.commands = [];
	await manager.restartFrom(task.id, task.messages[1].id, "edited");
	expect(sent).toBe("edited");
	expect(task.messages).toEqual(original.slice(0, 1));
	expect(task.engineSessionId).not.toBe(task.id);
	const seed = await restartSeed(taskDir, task.engineSessionId!);
	expect(JSON.stringify(seed)).not.toContain("fixture-secret");
	expect(seed).toHaveLength(2);
	const archive = JSON.parse(
		await readFile(
			join(taskDir, "restarts", `${task.engineSessionId}.previous-task.json`),
			"utf8",
		),
	);
	expect(archive.messages).toEqual(original);
	expect(new DesktopStore(store.file).state.tasks[0].engineSessionId).toBe(
		task.engineSessionId,
	);
});

test("invalid saved history leaves the original task unchanged", async () => {
	const { manager, task, taskDir } = await fixture();
	const before = structuredClone(task);
	await mkdir(join(taskDir, "turns"), { recursive: true });
	await writeFile(join(taskDir, "turns", `${task.messages[1].id}.json`), "{}");
	await expect(
		manager.restartFrom(task.id, task.messages[1].id, "edited"),
	).rejects.toThrow("history is invalid");
	expect(task).toEqual(before);
	expect(manager.external.size).toBe(0);
});

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { redact } from "@plinycode/shared/node";
import type { BackgroundCommand, State, Task } from "./contracts";

export class BackgroundCommands {
	private children = new Map<
		string,
		{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }
	>();
	constructor(
		private state: State,
		private runtime: string,
		private worker: string,
		private changed: () => void,
		private kill: (child: ChildProcessWithoutNullStreams) => Promise<void>,
	) {}
	get(taskId: string, id: string) {
		const value = this.state.commands?.find(
			(item) => item.id === id && item.taskId === taskId,
		);
		if (!value) throw new Error("Command not found in this task.");
		return value;
	}
	start(task: Task, command: string, secrets: string[]) {
		if (!task.cwd)
			throw new Error("Prepare the task folder before starting commands.");
		if (!command.trim() || command.length > 100_000)
			throw new Error("Invalid background command.");
		const record: BackgroundCommand = {
			id: randomUUID(),
			taskId: task.id,
			cwd: task.cwd,
			command: redact(command, secrets),
			status: "running",
			output: "",
			startedAt: Date.now(),
		};
		this.state.commands ??= [];
		this.state.commands.push(record);
		const child = spawn(this.runtime, [this.worker], {
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = createInterface({ input: child.stdout });
		let complete = false;
		child.stderr.resume();
		child.stdin.on("error", () => {});
		lines.on("line", (line) => {
			let event: { text?: string; done?: boolean; exitCode?: number };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.text)
				record.output = (record.output + redact(event.text, secrets)).slice(
					-100_000,
				);
			if (event.done) {
				complete = true;
				record.exitCode = event.exitCode;
				void this.kill(child);
			}
			this.changed();
		});
		const closed = new Promise<void>((accept) => {
			child.once("error", () => {
				record.output += "\nCommand worker could not start.";
			});
			child.once("close", () => {
				lines.close();
				if (record.status === "running")
					record.status =
						complete && record.exitCode === 0 ? "completed" : "failed";
				this.children.delete(record.id);
				this.changed();
				accept();
			});
		});
		this.children.set(record.id, { child, closed });
		child.stdin.write(
			`${JSON.stringify({ command, cwd: task.cwd, secrets })}\n`,
		);
		this.changed();
		return record;
	}
	async stop(taskId: string, id: string) {
		const record = this.get(taskId, id),
			running = this.children.get(id);
		if (running) {
			record.status = "stopped";
			await this.kill(running.child);
			await running.closed;
		}
		this.changed();
		return record;
	}
	async stopTask(id: string) {
		await Promise.all(
			(this.state.commands ?? [])
				.filter(
					(command) => command.taskId === id && command.status === "running",
				)
				.map((command) => this.stop(id, command.id)),
		);
	}
	async close() {
		await Promise.all(
			(this.state.commands ?? [])
				.filter((command) => command.status === "running")
				.map((command) => this.stop(command.taskId, command.id)),
		);
	}
}

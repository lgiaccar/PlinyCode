import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
	getPlinyApiKey,
	redact as redactSecrets,
} from "@plinycode/shared/node";
import { BackgroundCommands } from "./commands";
import {
	active,
	type Message,
	type Project,
	type RunInput,
	type Task,
	type WorkerEvent,
} from "./contracts";
import { git, isGit, overlaps, prepareWorktree } from "./git";
import { historyBefore } from "./history";
import { type ConnectedMcpServer, mcpSecretValues } from "./mcp-contracts";
import {
	projectFolders,
	supportsWorktree,
	taskFolders,
} from "./project-folders";
import type { DesktopStore } from "./store";

export function stopTree(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((accept) => {
		if (!child.pid || child.exitCode !== null || child.signalCode !== null)
			return accept();
		if (process.platform === "win32") {
			const kill = spawn(
				"taskkill.exe",
				["/PID", String(child.pid), "/T", "/F"],
				{ windowsHide: true, stdio: "ignore" },
			);
			kill.once("error", () => {
				child.kill();
				accept();
			});
			kill.once("close", () => accept());
		} else {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			accept();
		}
	});
}
const message = (role: Message["role"], text: string): Message => ({
	id: randomUUID(),
	role,
	text,
	at: Date.now(),
});
type Running = {
	ready?: boolean;
	controller: AbortController;
	child?: ChildProcessWithoutNullStreams;
	folder: string;
	folders: string[];
	settled?: Promise<void>;
};
export class TaskManager {
	readonly external = new Set<string>();
	hostRequest?: (
		task: Task,
		event: Extract<WorkerEvent, { type: "host" }>,
		signal: AbortSignal,
	) => Promise<unknown>;
	releaseBrowser?: (task: string) => void;
	readonly commands: BackgroundCommands;
	readonly running = new Map<string, Running>();
	private queue = new Map<string, { prompt: string; cached: boolean }>();
	private closing = false;
	private probes = new Set<ChildProcessWithoutNullStreams>();
	private flushTimer?: ReturnType<typeof setTimeout>;
	constructor(
		readonly store: DesktopStore,
		readonly data: string,
		readonly runtime: string,
		readonly worker: string,
		readonly notify: () => void,
		readonly key = getPlinyApiKey,
		readonly mcp = (): ConnectedMcpServer[] => [],
	) {
		this.commands = new BackgroundCommands(
			store.state,
			runtime,
			join(dirname(worker), "command-worker.js"),
			() => {
				this.streamed();
				this.drain();
			},
			stopTree,
		);
	}
	async testMcp(server: ConnectedMcpServer) {
		if (this.closing) throw new Error("PlinyCode is closing.");
		const child = spawn(
			this.runtime,
			["--use-system-ca", join(dirname(this.worker), "probe.js")],
			{
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.probes.add(child);
		const lines = createInterface({ input: child.stdout });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<string[]>((accept, reject) => {
				timer = setTimeout(
					() => reject(new Error("MCP connection test timed out.")),
					(server.timeout + 5) * 1000,
				);
				child.once("error", () =>
					reject(new Error("MCP probe could not start.")),
				);
				child.once("close", () =>
					reject(new Error("MCP probe stopped before completing.")),
				);
				child.stdin.on("error", () => {});
				child.stderr.resume();
				lines.on("line", (line) => {
					let result: { tools?: string[]; error?: string };
					try {
						result = JSON.parse(line);
					} catch {
						return;
					}
					if (result.error) reject(new Error(result.error));
					else if (result.tools) accept(result.tools);
				});
				child.stdin.write(`${JSON.stringify({ server, cwd: this.data })}\n`);
			});
		} finally {
			if (timer) clearTimeout(timer);
			await stopTree(child);
			lines.close();
			this.probes.delete(child);
		}
	}
	changed() {
		this.store.save();
		this.notify();
	}
	private streamed() {
		if (!this.flushTimer)
			this.flushTimer = setTimeout(() => {
				this.flushTimer = undefined;
				this.changed();
			}, 100);
	}
	task(id: string) {
		const task = this.store.state.tasks.find((item) => item.id === id);
		if (!task) throw new Error("Conversation not found.");
		return task;
	}
	project(id: string) {
		const project = this.store.state.projects.find((item) => item.id === id);
		if (!project) throw new Error("Project not found.");
		return project;
	}
	private async canonicalFolders(paths: string[]) {
		if (!paths.length || paths.length > 32)
			throw new Error("Select between 1 and 32 project folders.");
		const folders: string[] = [];
		for (const path of paths) {
			const canonical = await realpath(path);
			if (!(await stat(canonical)).isDirectory())
				throw new Error("Select a project folder.");
			if (
				!folders.some(
					(folder) =>
						overlaps(folder, canonical) && folder.length === canonical.length,
				)
			)
				folders.push(canonical);
		}
		return folders;
	}
	async addProject(path: string | string[]) {
		const folders = await this.canonicalFolders(
			typeof path === "string" ? [path] : path,
		);
		const canonical = folders[0];
		const existing = this.store.state.projects.find((project) => {
			const roots = projectFolders(project);
			return (
				roots.length === folders.length &&
				roots.every(
					(root, index) =>
						overlaps(root, folders[index]) &&
						root.length === folders[index].length,
				)
			);
		});
		if (existing) return existing;
		const gitProject = await isGit(canonical);
		const remotes = gitProject
			? (await git(canonical, ["remote"])).split(/\r?\n/).filter(Boolean)
			: [];
		const project: Project = {
			id: randomUUID(),
			name: basename(canonical),
			path: canonical,
			folders,
			git: gitProject,
			base: "",
			target: "",
			remote: remotes.includes("origin") ? "origin" : (remotes[0] ?? "origin"),
			worktreeSource: remotes.length ? "remote" : "local",
		};
		this.store.state.projects.push(project);
		this.changed();
		return project;
	}
	async updateProject(
		id: string,
		settings: Pick<Project, "base" | "target" | "remote" | "worktreeSource"> & {
			name?: string;
			folders?: string[];
		},
	) {
		const project = this.project(id);
		const folders = settings.folders
			? await this.canonicalFolders(settings.folders)
			: projectFolders(project);
		if (
			!overlaps(folders[0], project.path) ||
			folders[0].length !== project.path.length
		)
			throw new Error(
				"Keep the original folder first. Create a new project to change its primary folder.",
			);
		if (
			this.store.state.tasks.some(
				(task) =>
					task.projectId === id &&
					(active(task) ||
						this.running.has(task.id) ||
						this.external.has(task.id) ||
						this.store.state.commands?.some(
							(command) =>
								command.taskId === task.id && command.status === "running",
						)),
			)
		)
			throw new Error(
				"Stop project tasks and background commands before changing project settings.",
			);
		Object.assign(project, {
			...settings,
			name: settings.name ?? project.name,
			folders,
			base: settings.base.trim(),
			target: settings.target.trim(),
		});
		this.changed();
	}
	async migrateProjects() {
		for (const project of this.store.state.projects) {
			if (project.worktreeSource !== undefined) continue;
			try {
				if (!(await stat(project.path)).isDirectory()) continue;
				// Probe failures leave the old entry untouched for a later retry.
				if (project.git) {
					const remotes = (await git(project.path, ["remote"]))
						.split(/\r?\n/)
						.filter(Boolean);
					project.worktreeSource = remotes.length ? "remote" : "local";
				} else project.worktreeSource = "local";
			} catch {
				/* Unavailable projects must not prevent app startup. */
			}
		}
		this.changed();
	}
	async restartFrom(id: string, messageId: string, prompt: string) {
		const task = this.task(id);
		if (
			this.closing ||
			active(task) ||
			this.running.has(id) ||
			this.external.has(id) ||
			this.store.state.commands?.some(
				(command) => command.taskId === id && command.status === "running",
			)
		)
			throw new Error(
				"Stop this task and its background commands before restarting.",
			);
		this.external.add(id);
		try {
			const directory = join(this.data, "tasks", id);
			const history = await historyBefore(directory, task, messageId);
			const secrets = [
				await this.key().catch(() => ""),
				...mcpSecretValues(this.mcp()),
			];
			const serialize = (value: unknown) =>
				JSON.stringify(value, (_key, item) =>
					typeof item === "string" ? redactSecrets(item, secrets) : item,
				);
			const revision = randomUUID();
			await mkdir(join(directory, "restarts"), { recursive: true });
			await writeFile(
				join(directory, "restarts", `${revision}.json`),
				serialize(history),
				{ mode: 0o600 },
			);
			await writeFile(
				join(directory, "restarts", `${revision}.previous-task.json`),
				serialize(task),
				{ mode: 0o600 },
			);
			if (this.closing)
				throw new Error(
					"PlinyCode is closing. The original conversation was kept.",
				);
			task.messages = task.messages.slice(
				0,
				task.messages.findIndex((entry) => entry.id === messageId),
			);
			task.engineSessionId = revision;
			task.subagents = [];
			delete task.input;
			delete task.error;
		} finally {
			this.external.delete(id);
		}
		this.send(id, prompt);
	}
	createTask(projectId: string, worktree: boolean) {
		const project = this.project(projectId);
		const task: Task = {
			id: randomUUID(),
			projectId,
			title: "New conversation",
			model: this.store.state.settings.model,
			permissions: { ...this.store.state.settings.permissions },
			status: "idle",
			messages: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			worktree: supportsWorktree(project) && worktree,
			folders: [...projectFolders(project)],
		};
		this.store.state.tasks.unshift(task);
		this.changed();
		return task;
	}
	send(
		id: string,
		prompt: string,
		cached = false,
		delivery?: "queue" | "steer",
	) {
		if (this.closing) throw new Error("PlinyCode is closing.");
		const task = this.task(id);
		if (this.external.has(id))
			throw new Error("Wait for this task's operation to finish.");
		if ((active(task) || this.running.has(id)) && delivery) {
			if (this.running.get(id)?.controller.signal.aborted)
				throw new Error(
					"This task is stopping. Keep your draft and retry after it stops.",
				);
			task.pendingMessages ??= [];
			if (task.pendingMessages.length >= 20)
				throw new Error(
					"There are already 20 pending messages. Wait or remove one first.",
				);
			task.pendingMessages.push({
				id: randomUUID(),
				text: prompt,
				delivery,
				status: "queued",
			});
			this.changed();
			this.deliverSteering(task);
			return;
		}
		if (active(task) || this.running.has(id) || this.external.has(id))
			throw new Error(
				"Wait for this task to stop before sending another message.",
			);
		if (!task.messages.some((entry) => entry.role === "user"))
			task.title = prompt.split("\n")[0].slice(0, 70);
		task.messages.push(message("user", prompt));
		task.updatedAt = Date.now();
		delete task.error;
		delete task.input;
		task.status = "queued";
		this.queue.set(id, { prompt, cached });
		this.changed();
		this.drain();
	}
	removePending(id: string, messageId: string) {
		const task = this.task(id);
		const entry = task.pendingMessages?.find((item) => item.id === messageId);
		if (!entry || entry.status === "sending")
			throw new Error(
				"This message may already be reaching the agent. Stop the task before changing it.",
			);
		task.pendingMessages = task.pendingMessages?.filter(
			(item) => item.id !== messageId,
		);
		this.changed();
	}
	private deliverSteering(task: Task) {
		const run = this.running.get(task.id);
		if (
			!run?.ready ||
			!run.child ||
			run.controller.signal.aborted ||
			this.closing
		)
			return;
		if (task.pendingMessages?.some((item) => item.status === "sending")) return;
		const entry = task.pendingMessages?.find(
			(item) => item.delivery === "steer" && item.status === "queued",
		);
		if (!entry) return;
		entry.status = "sending";
		this.changed();
		run.child.stdin.write(
			JSON.stringify({ type: "steer", id: entry.id, prompt: entry.text }) +
				"\n",
		);
	}
	private holdPending(task: Task) {
		for (const entry of task.pendingMessages ?? []) entry.status = "held";
	}
	private drain() {
		if (this.closing) return;
		for (const [id, request] of this.queue) {
			const task = this.task(id),
				project = this.project(task.projectId);
			const folders = taskFolders(task, project);
			const intersects = (other: string[]) =>
				folders.some((folder) => other.some((root) => overlaps(root, folder)));
			if (
				(!task.worktree || !!task.cwd) &&
				((this.store.state.commands ?? []).some((command) => {
					if (command.status !== "running" || command.taskId === id)
						return false;
					const owner = this.store.state.tasks.find(
						(item) => item.id === command.taskId,
					);
					return intersects(
						owner
							? taskFolders(owner, this.project(owner.projectId))
							: [command.cwd],
					);
				}) ||
					[...this.running.values()].some((run) => intersects(run.folders)))
			)
				continue;
			this.queue.delete(id);
			const run: Running = {
				controller: new AbortController(),
				folder: task.cwd ?? project.path,
				folders,
			};
			this.running.set(id, run);
			task.status = "preparing";
			run.settled = this.execute(task, request, run).finally(() => {
				this.running.delete(id);
				if (task.status === "completed" && !this.closing) {
					const next = task.pendingMessages?.find(
						(item) => item.status === "queued",
					);
					if (next) {
						task.pendingMessages = task.pendingMessages?.filter(
							(item) => item.id !== next.id,
						);
						this.send(id, next.text);
					}
				} else this.holdPending(task);
				// A lost worker acknowledgement is never automatically retried.
				for (const entry of task.pendingMessages ?? [])
					if (entry.status === "sending") entry.status = "held";
				this.changed();
				this.drain();
			});
		}
		this.changed();
	}
	private async execute(
		task: Task,
		request: { prompt: string; cached: boolean },
		run: Running,
	) {
		try {
			const apiKey = await this.key();
			const mcpServers = this.mcp().filter((server) => server.enabled);
			const secrets = [apiKey, ...mcpSecretValues(mcpServers)];
			run.controller.signal.throwIfAborted();
			const project = this.project(task.projectId);
			if (!task.cwd) {
				if (task.worktree)
					Object.assign(
						task,
						await prepareWorktree(
							project,
							task,
							this.data,
							request.cached,
							run.controller.signal,
						),
					);
				else task.cwd = await realpath(project.path);
			}
			run.folder = task.cwd ?? project.path;
			run.folders = taskFolders(task, project);
			for (const folder of run.folders) {
				const canonical = await realpath(folder);
				if (canonical !== folder || !(await stat(canonical)).isDirectory())
					throw new Error(
						`Project folder changed or is unavailable: ${folder}`,
					);
			}
			if (!task.worktree) task.folders = [...run.folders];
			run.controller.signal.throwIfAborted();
			if (!(await stat(run.folder)).isDirectory())
				throw new Error("The task's working folder no longer exists.");
			task.status = "running";
			this.changed();
			const child = spawn(this.runtime, ["--use-system-ca", this.worker], {
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PLINY_DESKTOP_TASK: task.id },
			});
			run.child = child;
			const redact = (text: string) => redactSecrets(text, secrets);
			let stderr = "",
				done = false;
			let completedStatus: "completed" | "failed" = "failed";
			let response = message("assistant", "");
			let steered = false;
			task.messages.push(response);
			child.stderr.on("data", (chunk) => {
				stderr = (stderr + chunk.toString()).slice(-4000);
			});
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				let event: WorkerEvent;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "ready") {
					run.ready = true;
					this.deliverSteering(task);
				}
				if (event.type === "steering") {
					const entry = task.pendingMessages?.find(
						(item) => item.id === event.id,
					);
					if (entry && event.status === "received") {
						steered = true;
						task.pendingMessages = task.pendingMessages?.filter(
							(item) => item.id !== entry.id,
						);
						task.messages.push({
							...message("user", redact(entry.text)),
							id: entry.id,
						});
						task.messages.push(
							message("activity", "Steering received by the agent."),
						);
						response = message("assistant", "");
						task.messages.push(response);
						this.changed();
						this.deliverSteering(task);
					} else if (entry) {
						entry.status = "queued";
						run.ready = false;
						this.changed();
					}
				}
				if (event.type === "command") {
					void (async () => {
						try {
							if (run.controller.signal.aborted || this.closing)
								throw new Error("Task is stopping.");
							if (this.external.has(task.id))
								throw new Error(
									"A PR operation holds this task's write lease.",
								);
							const value =
								event.operation === "start"
									? this.commands.start(task, event.command ?? "", secrets)
									: event.operation === "stop"
										? await this.commands.stop(task.id, event.commandId ?? "")
										: this.commands.get(task.id, event.commandId ?? "");
							child.stdin.write(
								`${JSON.stringify({ type: "commandResult", requestId: event.requestId, value })}\n`,
							);
						} catch (error) {
							child.stdin.write(
								`${JSON.stringify({ type: "commandResult", requestId: event.requestId, error: String(error instanceof Error ? error.message : error) })}\n`,
							);
						}
					})();
				}
				if (event.type === "host") {
					void (async () => {
						try {
							run.controller.signal.throwIfAborted();
							if (!this.hostRequest)
								throw new Error("Desktop integration is unavailable.");
							const value = await this.hostRequest(
								task,
								event,
								run.controller.signal,
							);
							child.stdin.write(
								`${JSON.stringify({ type: "commandResult", requestId: event.requestId, value })}\n`,
							);
						} catch (error) {
							child.stdin.write(
								`${JSON.stringify({ type: "commandResult", requestId: event.requestId, error: redact(String(error instanceof Error ? error.message : error)) })}\n`,
							);
						}
					})();
				}
				if (event.type === "text") {
					response.text += event.text;
					this.streamed();
				}
				if (event.type === "subagent") {
					task.subagents ??= [];
					const agents = task.subagents;
					let agent = agents.find((item) => item.id === event.id);
					if (!agent) {
						agent = { id: event.id, status: "running", text: "" };
						agents.push(agent);
					}
					if (event.status) agent.status = event.status;
					if (event.text !== undefined)
						agent.text = redact(
							event.replace ? event.text : agent.text + event.text,
						).slice(-100_000);
					if (event.tool) agent.tool = redact(event.tool);
					if (event.inputTokens !== undefined)
						agent.inputTokens = event.inputTokens;
					if (event.outputTokens !== undefined)
						agent.outputTokens = event.outputTokens;
					this.streamed();
				}
				if (event.type === "activity") {
					task.messages.push(message("activity", redact(event.text)));
					this.streamed();
				}
				if (event.type === "input" && !run.controller.signal.aborted) {
					task.input = {
						id: event.id,
						kind: event.kind,
						text: redact(event.text),
					};
					task.status = "needs_input";
					this.changed();
				}
				if (event.type === "done") {
					done = true;
					run.ready = false;
					if (event.text && !steered) response.text = redact(event.text);
					completedStatus = event.status;
					task.error = event.error ? redact(event.error) : undefined;
					delete task.input;
					this.changed();
					void stopTree(child);
				}
			});
			child.stdin.on("error", () => {});
			const finished = new Promise<void>((accept, reject) => {
				child.once("error", reject);
				child.once("close", () => {
					lines.close();
					accept();
				});
			});
			const input: RunInput = {
				task,
				directory: join(this.data, "tasks", task.id),
				prompt: request.prompt,
				settings: this.store.state.settings,
				apiKey,
				mcpServers,
			};
			child.stdin.write(`${JSON.stringify({ type: "run", input })}\n`);
			if (run.controller.signal.aborted) await stopTree(child);
			await finished;
			if (done) task.status = completedStatus;
			if (!done && !run.controller.signal.aborted)
				throw new Error(
					redact(
						stderr ||
							"The task worker exited unexpectedly. Review activity before resuming.",
					),
				);
		} catch (error) {
			task.status = run.controller.signal.aborted ? "cancelled" : "failed";
			task.error = run.controller.signal.aborted
				? "Stopped. Send a new message to continue explicitly."
				: String(error instanceof Error ? error.message : error);
		} finally {
			this.releaseBrowser?.(task.id);
			for (const agent of task.subagents ?? [])
				if (agent.status === "running") agent.status = "interrupted";
			delete task.input;
			task.updatedAt = Date.now();
			if (run.controller.signal.aborted) task.status = "cancelled";
		}
	}
	reply(id: string, inputId: string, value: string) {
		const task = this.task(id),
			run = this.running.get(id);
		if (
			!run?.child ||
			task.input?.id !== inputId ||
			run.controller.signal.aborted
		)
			throw new Error("This question is no longer pending.");
		run.child.stdin.write(
			`${JSON.stringify({ type: "reply", id: inputId, value })}\n`,
		);
		delete task.input;
		task.status = "running";
		this.changed();
	}
	async cancel(id: string) {
		const task = this.task(id),
			run = this.running.get(id);
		this.queue.delete(id);
		this.holdPending(task);
		run?.controller.abort();
		await this.commands.stopTask(id);
		if (run) {
			run.controller.abort();
			if (run.child) {
				run.child.stdin.write('{"type":"cancel"}\n');
				await Promise.race([
					run.settled,
					new Promise((accept) => setTimeout(accept, 1500)),
				]);
				await stopTree(run.child);
			}
			await run.settled;
		}
		task.status = "cancelled";
		delete task.input;
		this.changed();
		this.drain();
	}
	async close() {
		this.closing = true;
		await this.commands.close();
		await Promise.all([...this.probes].map(stopTree));
		await Promise.all(
			[...new Set([...this.running.keys(), ...this.queue.keys()])].map((id) =>
				this.cancel(id),
			),
		);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.store.save();
	}
}

import { BrowserBridge } from "./browser";
import { active, type Task, type WorkerEvent } from "./contracts";
import type { EmbeddedBrowser } from "./embedded-browser";
import type { TaskManager } from "./manager";
import { type PrCreate, prCreateSchema } from "./pr-contracts";
import {
	PullRequestProvider,
	previewPullRequest,
	publishPullRequest,
} from "./pull-requests";
import type { SecretVault } from "./vault";

export class Integrations {
	browser?: BrowserBridge;
	embeddedBrowser?: EmbeddedBrowser;
	private operations = new Map<
		string,
		{ controller: AbortController; result: Promise<unknown> }
	>();
	private closing = false;
	private pairing: Promise<void> = Promise.resolve();
	constructor(
		private manager: TaskManager,
		private vault: SecretVault,
	) {
		manager.releaseBrowser = (id) => {
			this.browser?.release(id);
			this.embeddedBrowser?.release(id);
		};
		manager.hostRequest = (task, event, signal) =>
			this.host(task, event, signal);
	}
	pair(extensionId: string) {
		const operation = this.pairing.then(async () => {
			await this.browser?.close();
			if (this.closing) throw new Error("PlinyCode is closing.");
			this.browser = new BrowserBridge(extensionId);
			return this.browser.start();
		});
		this.pairing = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}
	disconnectBrowser() {
		const operation = this.pairing.then(async () => {
			await this.browser?.close();
			this.browser = undefined;
		});
		this.pairing = operation.catch(() => {});
		return operation;
	}
	provider(task: Task) {
		const project = this.manager.project(task.projectId);
		if (!project.prRepository)
			throw new Error("Configure the PR provider in project settings first.");
		return new PullRequestProvider(
			project.prRepository,
			this.vault.read(`pr:${project.id}`).env.TOKEN ?? "",
		);
	}
	async preview(task: Task) {
		const preview = await previewPullRequest(
			task,
			this.manager.project(task.projectId),
		);
		// Never send a credential embedded in a Git remote back to the renderer/model.
		if (/^[a-z]+:\/\/[^/]*@/i.test(preview.remote)) {
			const remote = new URL(preview.remote);
			remote.username = "";
			remote.password = "";
			preview.remote = remote.href;
		}
		return preview;
	}
	async refresh(task: Task, signal?: AbortSignal) {
		const preview = await this.preview(task);
		const provider = this.provider(task),
			target = task.pullRequest?.target || preview.target;
		const result = task.pullRequest?.number
			? await provider.get(task.pullRequest.number, target, signal)
			: await provider.find(preview.branch, target, signal);
		if (result) {
			task.pullRequest = result;
			this.manager.changed();
		}
		return (
			result ?? {
				status: "not_found",
				message:
					"No open PR found. An uncertain request may still be processing; inspect the provider before retrying.",
			}
		);
	}
	create(
		task: Task,
		input: PrCreate,
		worker = false,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.closing) return Promise.reject(new Error("PlinyCode is closing."));
		if (
			this.operations.has(task.id) ||
			this.manager.external.has(task.id) ||
			(!worker && (active(task) || this.manager.running.has(task.id))) ||
			(task.subagents ?? []).some((agent) => agent.status === "running") ||
			(this.manager.store.state.commands ?? []).some(
				(command) => command.taskId === task.id && command.status === "running",
			)
		)
			return Promise.reject(
				new Error(
					"Stop this task's active agents and background commands before publishing.",
				),
			);
		const controller = new AbortController();
		this.manager.external.add(task.id);
		// Enter the map synchronously before any asynchronous validation or writes.
		const result = Promise.resolve()
			.then(() =>
				publishPullRequest(
					task,
					this.manager.project(task.projectId),
					prCreateSchema.parse(input),
					this.provider(task),
					() => this.manager.changed(),
					signal
						? AbortSignal.any([signal, controller.signal])
						: controller.signal,
				),
			)
			.finally(() => {
				this.operations.delete(task.id);
				this.manager.external.delete(task.id);
			});
		this.operations.set(task.id, { controller, result });
		return result;
	}
	private async host(
		task: Task,
		event: Extract<WorkerEvent, { type: "host" }>,
		signal: AbortSignal,
	) {
		signal.throwIfAborted();
		if (this.closing) throw new Error("PlinyCode is closing.");
		switch (event.operation) {
			case "browser": {
				const input = event.input;
				if (input.operation === "release") {
					this.browser?.release(task.id);
					this.embeddedBrowser?.release(task.id);
					return "Released this task's browser tabs.";
				}
				if (this.embeddedBrowser) {
					if (input.operation === "tabs") {
						const embedded = (await this.embeddedBrowser.request(
							task.id,
							input,
							signal,
						)) as unknown[];
						const shared = this.browser?.status().connected
							? ((await this.browser.request(
									task.id,
									input,
									signal,
								)) as unknown[])
							: [];
						return [...embedded, ...shared];
					}
					if (input.tabId === undefined || input.tabId === 0)
						return this.embeddedBrowser.request(task.id, input, signal);
				}
				if (!this.browser)
					throw new Error("Pair the browser companion in Settings first.");
				return this.browser.request(task.id, event.input, signal);
			}
			case "prPreview":
				return this.preview(task);
			case "prRefresh":
				return this.refresh(task, signal);
			case "prCreate":
				return this.create(task, event.input, true, signal);
		}
	}
	async close() {
		this.closing = true;
		this.embeddedBrowser?.close();
		await this.pairing;
		for (const operation of this.operations.values())
			operation.controller.abort();
		await Promise.allSettled(
			[...this.operations.values()].map((operation) => operation.result),
		);
		await this.browser?.close();
	}
}

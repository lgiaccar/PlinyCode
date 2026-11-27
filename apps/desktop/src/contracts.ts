import { z } from "zod";
import type { BrowserAction, BrowserStatus } from "./browser-contracts";
import type { UpdateStatus } from "./desktop-update";
import {
	type EmbeddedBrowserState,
	embeddedBrowserCommandSchema,
} from "./embedded-browser-contracts";
import {
	type ConnectedMcpServer,
	type McpServer,
	mcpSecretsSchema,
	mcpServerSchema,
} from "./mcp-contracts";
import {
	type PrCreate,
	type PrPreview,
	type PrRepository,
	type PullRequest,
	prCreateSchema,
	prRepositorySchema,
} from "./pr-contracts";

export const permissionsSchema = z.object({
	read: z.boolean(),
	edit: z.boolean(),
	commands: z.boolean(),
	web: z.boolean(),
	mcp: z.boolean(),
	subagents: z.boolean(),
});
export type Permissions = z.infer<typeof permissionsSchema>;
export const defaultPermissions: Permissions = {
	read: true,
	edit: false,
	commands: false,
	web: false,
	mcp: false,
	subagents: false,
};
export const settingsSchema = z.object({
	autoCheckUpdates: z.boolean().default(true),
	permissions: permissionsSchema,
	model: z.string().min(1).max(200),
	subagents: z.object({
		maxConcurrent: z.number().int().min(1).max(6),
		maxDepth: z.number().int().min(1).max(2),
	}),
});
export type Settings = z.infer<typeof settingsSchema>;
export interface Project {
	/** Ordered workspace roots; legacy projects use path as their only root. */
	folders?: string[];
	prRepository?: PrRepository;
	hasPrToken?: boolean;
	id: string;
	name: string;
	path: string;
	git: boolean;
	base: string;
	target: string;
	remote: string;
	worktreeSource?: "remote" | "local";
}
export interface Message {
	id: string;
	role: "user" | "assistant" | "activity";
	text: string;
	at: number;
}
export type TaskStatus =
	| "idle"
	| "preparing"
	| "queued"
	| "running"
	| "needs_input"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";
export interface PendingMessage {
	id: string;
	text: string;
	delivery: "queue" | "steer";
	status: "queued" | "sending" | "held";
}
export interface Task {
	/** Snapshot at creation: changing a project never retargets an existing chat. */
	folders?: string[];
	pendingMessages?: PendingMessage[];
	engineSessionId?: string;
	pullRequest?: PullRequest;
	subagents?: Subagent[];
	id: string;
	projectId: string;
	title: string;
	model: string;
	permissions: Permissions;
	status: TaskStatus;
	messages: Message[];
	createdAt: number;
	updatedAt: number;
	worktree: boolean;
	cwd?: string;
	branch?: string;
	baseCommit?: string;
	baseBranch?: string;
	error?: string;
	input?: { id: string; kind: "approval" | "question"; text: string };
}
export interface Subagent {
	id: string;
	status: "running" | "completed" | "failed" | "interrupted";
	text: string;
	tool?: string;
	inputTokens?: number;
	outputTokens?: number;
}
export interface State {
	version: 1;
	projects: Project[];
	tasks: Task[];
	settings: Settings;
	mcpServers?: McpServer[];
	commands?: BackgroundCommand[];
}
export interface BackgroundCommand {
	id: string;
	taskId: string;
	command: string;
	cwd: string;
	status: "running" | "completed" | "failed" | "stopped" | "interrupted";
	output: string;
	exitCode?: number;
	startedAt: number;
}
export const freshState = (): State => ({
	version: 1,
	projects: [],
	tasks: [],
	settings: {
		autoCheckUpdates: true,
		permissions: { ...defaultPermissions },
		model: "pliny/auto-free",
		subagents: { maxConcurrent: 3, maxDepth: 1 },
	},
});
export const active = (task: Task) =>
	["preparing", "queued", "running", "needs_input"].includes(task.status);
export const actionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("openLink"), url: z.string().max(8192) }),
	z.object({ type: z.literal("loadDrafts") }),
	z.object({
		type: z.literal("saveDraft"),
		id: z.string().uuid(),
		text: z.string().max(200_000),
		revision: z.number().int().nonnegative(),
	}),
	z.object({
		type: z.literal("removePending"),
		id: z.string().uuid(),
		messageId: z.string().uuid(),
	}),
	z.object({
		type: z.literal("embeddedBrowser"),
		command: embeddedBrowserCommandSchema,
	}),
	z.object({
		type: z.literal("suggestNextPrompt"),
		id: z.string().uuid(),
		messageId: z.string().uuid(),
	}),
	z.object({
		type: z.literal("copyMessage"),
		id: z.string().uuid(),
		messageId: z.string().uuid(),
	}),
	z.object({
		type: z.literal("restartFrom"),
		id: z.string().uuid(),
		messageId: z.string().uuid(),
		prompt: z.string().trim().min(1).max(200_000),
	}),
	z.object({ type: z.literal("updateStatus") }),
	z.object({ type: z.literal("updateCheck") }),
	z.object({ type: z.literal("updateDownload") }),
	z.object({ type: z.literal("updateInstall") }),
	z.object({
		type: z.literal("browserPair"),
		extensionId: z.string().regex(/^[a-p]{32}$/),
	}),
	z.object({ type: z.literal("browserStatus") }),
	z.object({ type: z.literal("browserDisconnect") }),
	z.object({ type: z.literal("browserExtensionFolder") }),
	z.object({
		type: z.literal("savePrRepository"),
		id: z.string().uuid(),
		repository: prRepositorySchema,
		token: z.string().trim().min(1).max(10_000).optional(),
	}),
	z.object({ type: z.literal("prPreview"), id: z.string().uuid() }),
	z.object({ type: z.literal("prRefresh"), id: z.string().uuid() }),
	z.object({
		type: z.literal("prCreate"),
		id: z.string().uuid(),
		input: prCreateSchema,
	}),
	z.object({ type: z.literal("prOpen"), id: z.string().uuid() }),
	z.object({ type: z.literal("snapshot") }),
	z.object({ type: z.literal("models") }),
	z.object({ type: z.literal("attachFiles") }),
	z.object({
		type: z.literal("stopCommand"),
		id: z.string().uuid(),
		commandId: z.string().uuid(),
	}),
	z.object({
		type: z.literal("saveMcp"),
		server: mcpServerSchema,
		secrets: mcpSecretsSchema.optional(),
	}),
	z.object({ type: z.literal("removeMcp"), id: z.string().uuid() }),
	z.object({ type: z.literal("testMcp"), id: z.string().uuid() }),
	z.object({ type: z.literal("addProject") }),
	z.object({ type: z.literal("pickProjectFolders") }),
	z.object({
		type: z.literal("projectSettings"),
		id: z.string().uuid(),
		name: z.string().trim().min(1).max(200).optional(),
		folders: z.array(z.string().min(1).max(8192)).min(1).max(32).optional(),
		worktreeSource: z.enum(["remote", "local"]).default("remote"),
		base: z.string().max(200),
		target: z.string().max(200),
		remote: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
	}),
	z.object({
		type: z.literal("createTask"),
		projectId: z.string().uuid(),
		worktree: z.boolean(),
	}),
	z.object({
		type: z.literal("configureTask"),
		id: z.string().uuid(),
		permissions: permissionsSchema,
		model: z.string().min(1).max(200),
	}),
	z.object({
		type: z.literal("send"),
		id: z.string().uuid(),
		prompt: z.string().trim().min(1).max(200_000),
		cached: z.boolean().optional(),
		delivery: z.enum(["queue", "steer"]).optional(),
	}),
	z.object({
		type: z.literal("improvePrompt"),
		prompt: z.string().max(200_000),
	}),
	z.object({ type: z.literal("cancel"), id: z.string().uuid() }),
	z.object({
		type: z.literal("reply"),
		id: z.string().uuid(),
		inputId: z.string().uuid(),
		value: z.string().max(100_000),
	}),
	z.object({ type: z.literal("settings"), settings: settingsSchema }),
	z.object({
		type: z.literal("saveKey"),
		key: z.string().trim().min(1).max(10_000),
	}),
	z.object({
		type: z.literal("openFolder"),
		id: z.string().uuid(),
		folder: z.string().optional(),
	}),
	z.object({ type: z.literal("diff"), id: z.string().uuid() }),
]);
export type Action = Exclude<
	z.infer<typeof actionSchema>,
	{ type: "saveDraft" }
>;
export interface DesktopApi {
	saveDraft(
		id: string,
		draft: { text: string; revision: number },
	): Promise<void>;
	invoke(action: Action): Promise<{
		state: State;
		drafts?: Record<string, { text: string; revision: number }>;
		selectedTask?: string;
		diff?: string;
		credentialAvailable?: boolean;
		models?: string[];
		mcpTools?: string[];
		files?: string[];
		browser?: BrowserStatus;
		embeddedBrowser?: EmbeddedBrowserState;
		prPreview?: PrPreview;
		suggestedPrompt?: string;
		improvedPrompt?: { text?: string; error?: string };
		update?: UpdateStatus;
	}>;
	subscribe(listener: (state: State) => void): () => void;
	subscribeUpdates(listener: (state: UpdateStatus) => void): () => void;
	subscribeBrowser(listener: (state: EmbeddedBrowserState) => void): () => void;
}
declare global {
	interface Window {
		plinycode: DesktopApi;
	}
}
export interface RunInput {
	task: Task;
	directory: string;
	prompt: string;
	settings: Settings;
	apiKey: string;
	mcpServers?: ConnectedMcpServer[];
}
export type WorkerEvent =
	| { type: "ready" }
	| { type: "steering"; id: string; status: "received" | "deferred" }
	| {
			type: "host";
			requestId: string;
			operation: "browser";
			input: BrowserAction;
	  }
	| { type: "host"; requestId: string; operation: "prCreate"; input: PrCreate }
	| {
			type: "host";
			requestId: string;
			operation: "prRefresh" | "prPreview";
			input: Record<string, never>;
	  }
	| {
			type: "subagent";
			id: string;
			status?: Subagent["status"];
			text?: string;
			replace?: boolean;
			tool?: string;
			inputTokens?: number;
			outputTokens?: number;
	  }
	| {
			type: "command";
			requestId: string;
			operation: "start" | "output" | "stop";
			command?: string;
			commandId?: string;
	  }
	| { type: "text"; text: string }
	| { type: "activity"; text: string }
	| { type: "input"; id: string; kind: "approval" | "question"; text: string }
	| {
			type: "done";
			text: string;
			status: "completed" | "failed";
			error?: string;
	  };

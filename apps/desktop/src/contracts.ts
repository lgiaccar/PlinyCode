import { z } from "zod";
import type { BrowserAction, BrowserStatus } from "./browser-contracts";
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
	permissions: permissionsSchema,
	model: z.string().min(1).max(200),
	subagents: z.object({
		maxConcurrent: z.number().int().min(1).max(6),
		maxDepth: z.number().int().min(1).max(2),
	}),
});
export type Settings = z.infer<typeof settingsSchema>;
export interface Project {
	prRepository?: PrRepository;
	hasPrToken?: boolean;
	id: string;
	name: string;
	path: string;
	git: boolean;
	base: string;
	target: string;
	remote: string;
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
export interface Task {
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
		permissions: { ...defaultPermissions },
		model: "pliny/auto-free",
		subagents: { maxConcurrent: 3, maxDepth: 1 },
	},
});
export const active = (task: Task) =>
	["preparing", "queued", "running", "needs_input"].includes(task.status);
export const actionSchema = z.discriminatedUnion("type", [
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
	z.object({
		type: z.literal("projectSettings"),
		id: z.string().uuid(),
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
	z.object({ type: z.literal("openFolder"), id: z.string().uuid() }),
	z.object({ type: z.literal("diff"), id: z.string().uuid() }),
]);
export type Action = z.infer<typeof actionSchema>;
export interface DesktopApi {
	invoke(action: Action): Promise<{
		state: State;
		selectedTask?: string;
		diff?: string;
		credentialAvailable?: boolean;
		models?: string[];
		mcpTools?: string[];
		files?: string[];
		browser?: BrowserStatus;
		prPreview?: PrPreview;
	}>;
	subscribe(listener: (state: State) => void): () => void;
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

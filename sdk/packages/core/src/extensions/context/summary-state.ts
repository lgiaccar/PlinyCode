import type { MessageWithMetadata } from "@plinycode/shared";

/**
 * State that a compaction summary pins by code rather than by asking the
 * summarizer for it: the model's task list and the last failed command. A
 * model that reads the summary after a compaction then knows where the run
 * stands (the HexCore session lost "execute PLAN.md, five phases" to "add
 * Communicator plumbing" after a few summaries) and what last went wrong,
 * which the summarizer's prose tends to drop.
 */

/** The task-list tool of the extension; its latest input is the whole list. */
export const TODO_LIST_TOOL_NAME = "update_todo_list";
const MAX_TODO_ITEMS = 30;
const MAX_TODO_CHARS = 2_000;
const MAX_TODO_ITEM_CHARS = 300;

/** Tools whose failed result is worth carrying into the summary. */
const FAILURE_TOOLS = new Set(["run_commands", "editor", "apply_patch"]);
const MAX_FAILURE_CHARS = 1_000;
const MAX_FAILURE_CALL_CHARS = 200;

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
	content: string;
	status: TodoStatus;
}

const STATUS_ALIASES: Record<string, TodoStatus> = {
	pending: "pending",
	todo: "pending",
	open: "pending",
	not_started: "pending",
	in_progress: "in_progress",
	inprogress: "in_progress",
	active: "in_progress",
	doing: "in_progress",
	started: "in_progress",
	completed: "completed",
	complete: "completed",
	done: "completed",
	finished: "completed",
};

function normalizeStatus(value: unknown): TodoStatus {
	if (typeof value !== "string") {
		return "pending";
	}
	return (
		STATUS_ALIASES[
			value
				.trim()
				.toLowerCase()
				.replace(/[\s-]+/g, "_")
		] ?? "pending"
	);
}

function parseChecklistLine(line: string): TodoItem | undefined {
	const match = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\[([^\]]?)\])?\s*(.*)$/.exec(line);
	const content = match?.[2]?.trim() ?? "";
	if (!content) {
		return undefined;
	}
	const box = match?.[1];
	const status: TodoStatus =
		box === undefined || box.trim() === ""
			? "pending"
			: /^x$/i.test(box)
				? "completed"
				: "in_progress";
	return { content, status };
}

function normalizeItem(item: unknown): TodoItem | undefined {
	if (typeof item === "string") {
		return parseChecklistLine(item);
	}
	if (!item || typeof item !== "object") {
		return undefined;
	}
	const record = item as Record<string, unknown>;
	const content = [
		record.content,
		record.task,
		record.text,
		record.title,
		record.description,
	].find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
	if (!content) {
		return undefined;
	}
	const status =
		record.status === undefined &&
		(record.done === true || record.completed === true)
			? "completed"
			: normalizeStatus(record.status);
	return { content: content.trim(), status };
}

/**
 * The task list in whatever shape the model sent it: `{ todos: [...] }`,
 * `{ items | tasks | list }`, a JSON string, a markdown checklist, or bare
 * strings. Mirrors the extension's `normalizeTodoList` so the summary shows
 * what the chat showed.
 */
export function normalizeTodoListInput(raw: unknown): TodoItem[] {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			// A markdown checklist: handled below as lines.
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		value = record.todos ?? record.items ?? record.tasks ?? record.list;
		if (typeof value === "string") {
			try {
				value = JSON.parse(value);
			} catch {
				// Lines.
			}
		}
	}
	const entries: unknown[] =
		typeof value === "string"
			? value.split(/\r?\n/)
			: Array.isArray(value)
				? value
				: [];
	return entries
		.map(normalizeItem)
		.filter((item): item is TodoItem => item !== undefined)
		.slice(0, MAX_TODO_ITEMS)
		.map((item) => ({
			...item,
			content: item.content.slice(0, MAX_TODO_ITEM_CHARS),
		}));
}

function renderTodoList(items: TodoItem[]): string {
	const lines = items.map((item) => {
		const box =
			item.status === "completed"
				? "[x]"
				: item.status === "in_progress"
					? "[>]"
					: "[ ]";
		return `- ${box} ${item.content}`;
	});
	let text = lines.join("\n");
	if (text.length > MAX_TODO_CHARS) {
		text = `${text.slice(0, MAX_TODO_CHARS)}\n...[truncated]`;
	}
	return text;
}

/**
 * The newest task list the model wrote with `update_todo_list` in `messages`,
 * rendered as a checklist (`[x]` done, `[>]` in progress, `[ ]` pending), or
 * undefined when the tool was never used in the span.
 */
export function extractTodoList(
	messages: readonly MessageWithMetadata[],
	toolName: string = TODO_LIST_TOOL_NAME,
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (
			let blockIndex = message.content.length - 1;
			blockIndex >= 0;
			blockIndex -= 1
		) {
			const block = message.content[blockIndex];
			if (block.type !== "tool_use" || block.name !== toolName) {
				continue;
			}
			const items = normalizeTodoListInput(block.input);
			if (items.length > 0) {
				return renderTodoList(items);
			}
		}
	}
	return undefined;
}

function toolResultText(
	content: string | Array<{ type: string; text?: string; content?: string }>,
): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) =>
			block.type === "text"
				? (block.text ?? "")
				: block.type === "file"
					? (block.content ?? "")
					: "",
		)
		.join("\n");
}

/**
 * Whether a tool result reports a failure: the provider's error flag, or a
 * structured result (one entry, or a list of entries) with `success: false`
 * or an `error`.
 */
function isFailedToolResult(block: {
	is_error?: boolean;
	content: string | Array<{ type: string; text?: string; content?: string }>;
}): boolean {
	if (block.is_error) {
		return true;
	}
	const text = toolResultText(block.content).trim();
	if (!text.startsWith("{") && !text.startsWith("[")) {
		return false;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		return entries.some(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				((entry as { success?: unknown }).success === false ||
					typeof (entry as { error?: unknown }).error === "string"),
		);
	} catch {
		return false;
	}
}

function describeToolCall(name: string, input: unknown): string {
	let args = "";
	try {
		args = JSON.stringify(input ?? {});
	} catch {
		args = String(input);
	}
	const line = `${name}(${args})`;
	return line.length > MAX_FAILURE_CALL_CHARS
		? `${line.slice(0, MAX_FAILURE_CALL_CHARS)}...`
		: line;
}

/**
 * The newest failed call of a command or edit tool in `messages`: the call on
 * one line and the head of its result. The summarizer's prose seldom keeps the
 * actual error; the model continuing after a compaction needs it verbatim.
 */
export function extractLastFailure(
	messages: readonly MessageWithMetadata[],
): string | undefined {
	const callsById = new Map<string, { name: string; input: unknown }>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use" && FAILURE_TOOLS.has(block.name)) {
				callsById.set(block.id, { name: block.name, input: block.input });
			}
		}
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "user" || !Array.isArray(message.content)) {
			continue;
		}
		for (
			let blockIndex = message.content.length - 1;
			blockIndex >= 0;
			blockIndex -= 1
		) {
			const block = message.content[blockIndex];
			if (block.type !== "tool_result") {
				continue;
			}
			const call = callsById.get(block.tool_use_id);
			if (!call || !isFailedToolResult(block)) {
				continue;
			}
			const head = toolResultText(block.content).trim();
			const body =
				head.length > MAX_FAILURE_CHARS
					? `${head.slice(0, MAX_FAILURE_CHARS)}\n...[truncated ${head.length - MAX_FAILURE_CHARS} chars]`
					: head;
			return `${describeToolCall(call.name, call.input)}\n${body}`;
		}
	}
	return undefined;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageWithMetadata } from "@plinycode/llms";
import { normalizeUserInput } from "@plinycode/shared";
import type { Task } from "./contracts";

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function messages(value: unknown): MessageWithMetadata[] {
	if (
		!Array.isArray(value) ||
		value.some(
			(entry) =>
				!entry ||
				typeof entry !== "object" ||
				!["user", "assistant", "system", "tool"].includes(entry.role) ||
				!(typeof entry.content === "string" || Array.isArray(entry.content)),
		)
	)
		throw new Error(
			"Saved conversation history is invalid. The original conversation was kept.",
		);
	return value;
}

/** Exact pre-turn snapshots survive compaction; legacy transcripts require a unique match. */
export async function historyBefore(
	directory: string,
	task: Task,
	messageId: string,
) {
	const index = task.messages.findIndex(
		(entry) => entry.id === messageId && entry.role === "user",
	);
	if (index < 0) throw new Error("Prompt not found.");
	if (!task.messages.slice(0, index).some((entry) => entry.role === "user"))
		return [];
	const snapshot = await readJson(
		join(directory, "turns", `${messageId}.json`),
	);
	if (snapshot !== undefined) return messages(snapshot);
	const sessionId = task.engineSessionId ?? task.id;
	const transcript = (await readJson(
		join(directory, "sessions", sessionId, `${sessionId}.messages.json`),
	)) as { messages?: unknown } | undefined;
	if (!transcript && !task.cwd) return []; // Worktree preparation failed before any engine turn.
	const history = messages(transcript?.messages);
	const prompt = task.messages[index].text;
	const matches = history.flatMap((entry, position) => {
		const text =
			typeof entry.content === "string"
				? entry.content
				: entry.content
						.filter((block) => block.type === "text")
						.map((block) => (block as { text: string }).text)
						.join("\n");
		return entry.role === "user" && normalizeUserInput(text) === prompt
			? [position]
			: [];
	});
	if (matches.length !== 1)
		throw new Error(
			"This older prompt cannot be located safely in the saved model history. Edit the first prompt to restart from the beginning, or copy this prompt into a new chat. The original conversation was kept.",
		);
	return history.slice(0, matches[0]);
}

export async function restartSeed(directory: string, sessionId: string) {
	const value = await readJson(
		join(directory, "restarts", `${sessionId}.json`),
	);
	return messages(value);
}

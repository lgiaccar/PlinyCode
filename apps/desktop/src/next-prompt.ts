import { type ApiHandler, createHandlerAsync } from "@plinycode/llms";
import { NextPromptSuggestions } from "@plinycode/shared";
import type { Task } from "./contracts";
import { IMPROVE_MODEL } from "./prompt-improver";
export class DesktopNextPrompt {
	private suggestions = new NextPromptSuggestions();
	constructor(private create: typeof createHandlerAsync = createHandlerAsync) {}
	close() {
		this.suggestions.close();
	}
	async suggest(
		task: Task,
		messageId: string,
		apiKey: string,
	): Promise<string> {
		const last = task.messages
			.slice()
			.reverse()
			.find((message) => message.role === "assistant");
		if (
			task.status !== "completed" ||
			!last?.text ||
			last.id !== messageId ||
			!apiKey
		)
			return "";
		const turns = task.messages
			.filter(
				(message) => message.role === "user" || message.role === "assistant",
			)
			.map((message) => ({
				role: message.role as "user" | "assistant",
				text: message.text,
			}));
		return this.suggestions.suggest(
			`${task.id}:${messageId}`,
			turns,
			async (system, user, signal) => {
				let handler: ApiHandler | undefined;
				const abort = () => handler?.abort?.();
				signal.addEventListener("abort", abort, { once: true });
				try {
					handler = await this.create({
						providerId: "pliny",
						modelId: IMPROVE_MODEL,
						apiKey,
						abortSignal: signal,
						timeoutMs: 12_000,
						maxOutputTokens: 128,
						thinking: false,
					});
					if (signal.aborted) return "";
					handler.setAbortSignal?.(signal);
					let text = "";
					for await (const chunk of handler.createMessage(system, [
						{ role: "user", content: user },
					])) {
						if (signal.aborted) return "";
						if (chunk.type === "text") text += chunk.text;
						if (
							text.length > 400 ||
							(chunk.type === "done" &&
								(!chunk.success || chunk.incompleteReason))
						)
							return "";
					}
					return text;
				} finally {
					signal.removeEventListener("abort", abort);
					handler?.abort?.();
				}
			},
		);
	}
}

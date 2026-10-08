import type { CoreSessionConfig } from "@plinycode/core"
import type { AgentModelRequest } from "@plinycode/shared"

/**
 * The last request each conversation's agent sent to its model, for the
 * "Show Last Model Request" command: the system prompt, the messages after
 * compaction and the tools, exactly as the agent built them. It answers "what
 * did the model actually see?", which the chat cannot: rows hide reminders and
 * notices, and the saved history is never compacted.
 *
 * Only a reference is kept, to objects the agent already holds, and only for
 * the few most recent conversations.
 */
interface CapturedRequest {
	sessionId: string
	/** The model the conversation runs on; for a router, the router's id, not the model it picked. */
	modelId: string
	at: number
	request: AgentModelRequest
}

const MAX_CONVERSATIONS = 8
const captured = new Map<string, CapturedRequest>()

function remember(entry: CapturedRequest): void {
	captured.delete(entry.sessionId)
	captured.set(entry.sessionId, entry)
	if (captured.size > MAX_CONVERSATIONS) {
		const oldest = captured.keys().next().value
		if (oldest !== undefined) {
			captured.delete(oldest)
		}
	}
}

/** Wraps the session's model factory, outermost, so each root request is recorded as it is sent. */
export function installLastRequestCapture(config: CoreSessionConfig, now: () => number = Date.now): CoreSessionConfig {
	const baseFactory = config.agentModelFactory
	config.agentModelFactory = (input) => {
		const model = baseFactory ? baseFactory(input) : input.createDefault()
		// Sub-agents have conversations of their own; the command shows the main one.
		if (input.config.parentAgentId) {
			return model
		}
		return {
			stream: (request) => {
				const sessionId = config.sessionId?.trim()
				if (sessionId) {
					remember({ sessionId, modelId: input.config.modelId, at: now(), request })
				}
				return model.stream(request)
			},
		}
	}
	return config
}

/**
 * The last request of a conversation as readable JSON: message content as
 * sent, tool schemas included, the abort signal left out. Undefined when the
 * conversation has not sent one since the extension started.
 */
export function formatLastModelRequest(sessionId: string): string | undefined {
	const entry = captured.get(sessionId)
	if (!entry) {
		return undefined
	}
	const { systemPrompt, messages, tools, modelTools, options } = entry.request
	return JSON.stringify(
		{
			sessionId: entry.sessionId,
			modelId: entry.modelId,
			sentAt: new Date(entry.at).toISOString(),
			note: "As the agent built it, before provider-specific conversion (tool-call ids, prompt caching, reasoning fields).",
			systemPrompt,
			messages,
			tools,
			...(modelTools?.length ? { modelTools } : {}),
			...(options ? { options } : {}),
		},
		null,
		2,
	)
}

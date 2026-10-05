import { isUserRunMessage } from "./user-run-messages";

/**
 * Off-the-record turns: side questions the user asks without adding them to
 * the conversation's context.
 *
 * The user message that starts such a turn carries `metadata.offTheRecord`.
 * The turn stays in the transcript, so the chat still shows it and reopening
 * the conversation replays it, but every later model request leaves out the
 * whole turn: the question, the replies, and the tool calls and results made
 * while answering it. The turn ends where the next user run starts
 * (`isUserRunMessage`), so synthetic notices inside it go with it.
 */
export const OFF_THE_RECORD_METADATA_KEY = "offTheRecord";

type MessageLike = {
	role?: unknown;
	content?: unknown;
	metadata?: unknown;
};

export function isOffTheRecordMessage(message: MessageLike): boolean {
	if (message.role !== "user") {
		return false;
	}
	const metadata = message.metadata;
	return (
		!!metadata &&
		typeof metadata === "object" &&
		(metadata as Record<string, unknown>)[OFF_THE_RECORD_METADATA_KEY] === true
	);
}

function findLastUserRunIndex(messages: readonly MessageLike[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isUserRunMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

/** True when the newest user run in `messages` is an off-the-record one. */
export function isOffTheRecordTurnActive(
	messages: readonly MessageLike[],
): boolean {
	const index = findLastUserRunIndex(messages);
	return index >= 0 && isOffTheRecordMessage(messages[index]);
}

/**
 * Removes off-the-record turns from `messages`.
 *
 * With `keepCurrentTurn`, the newest turn is kept even when it is off the
 * record, so a side question still sees its own question and tool results
 * while it is being answered. Returns a copy; the input is not changed.
 */
export function dropOffTheRecordTurns<T extends MessageLike>(
	messages: readonly T[],
	options: { keepCurrentTurn?: boolean } = {},
): T[] {
	const currentTurnStart = options.keepCurrentTurn
		? findLastUserRunIndex(messages)
		: -1;
	const out: T[] = [];
	let dropping = false;
	for (const [index, message] of messages.entries()) {
		if (isUserRunMessage(message)) {
			dropping = isOffTheRecordMessage(message) && index !== currentTurnStart;
		}
		if (!dropping) {
			out.push(message);
		}
	}
	return out;
}

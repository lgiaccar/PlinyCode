import type * as LlmsProviders from "@plinycode/llms";
import {
	projectSessionCompactionState,
	type SessionCompactionState,
} from "../../../session/models/session-compaction";
import type { ActiveSession } from "../../../types/session";
import type { SessionRecord } from "../../../types/sessions";

function isIncomingCompactionStateStale(
	incoming: SessionCompactionState,
	current: SessionCompactionState | undefined,
): boolean {
	if (!current) {
		return false;
	}
	if (incoming.source_message_count !== current.source_message_count) {
		return incoming.source_message_count < current.source_message_count;
	}
	return Date.parse(incoming.updated_at) < Date.parse(current.updated_at);
}

interface CompactionStateStoreDeps {
	readonly sessions: Map<string, ActiveSession>;
	getSession(sessionId: string): Promise<SessionRecord | undefined>;
	readSessionMessages(
		sessionId: string,
	): Promise<LlmsProviders.MessageWithMetadata[]>;
	invoke<T>(method: string, ...args: unknown[]): Promise<T>;
	invokeOptionalValue<T = unknown>(
		method: string,
		...args: unknown[]
	): Promise<T | undefined>;
}

/**
 * Reads and writes a session's compaction state, validating it against the
 * session's messages and serializing writes for active sessions.
 */
export class SessionCompactionStateStore {
	private readonly sessions: Map<string, ActiveSession>;

	constructor(private readonly deps: CompactionStateStoreDeps) {
		this.sessions = deps.sessions;
	}

	private getSession(sessionId: string): Promise<SessionRecord | undefined> {
		return this.deps.getSession(sessionId);
	}

	private readSessionMessages(
		sessionId: string,
	): Promise<LlmsProviders.MessageWithMetadata[]> {
		return this.deps.readSessionMessages(sessionId);
	}

	private invoke<T>(method: string, ...args: unknown[]): Promise<T> {
		return this.deps.invoke<T>(method, ...args);
	}

	private invokeOptionalValue<T = unknown>(
		method: string,
		...args: unknown[]
	): Promise<T | undefined> {
		return this.deps.invokeOptionalValue<T>(method, ...args);
	}

	async updateSessionCompactionState(
		sessionId: string,
		state: SessionCompactionState,
	): Promise<{ updated: boolean }> {
		const target = sessionId.trim();
		if (!target) return { updated: false };
		const activeSession = this.sessions.get(target);
		const sessionRecord = activeSession
			? undefined
			: await this.getSession(target);
		const existing = activeSession ?? sessionRecord;
		if (!existing) return { updated: false };
		if (activeSession) {
			const persistedMessages = await this.readSessionMessages(target);
			const hasPersistedSource =
				state.source_message_count > 0 &&
				persistedMessages.length >= state.source_message_count;
			const validationMessages = hasPersistedSource
				? persistedMessages
				: undefined;
			if (hasPersistedSource) {
				if (
					!(await this.canPersistCompactionState(
						target,
						state,
						activeSession,
						undefined,
						persistedMessages,
					))
				) {
					return { updated: false };
				}
				activeSession.agent.restore(persistedMessages);
			}
			return await this.persistActiveSessionCompactionState(
				activeSession,
				state,
				validationMessages,
			);
		}
		if (
			!(await this.canPersistCompactionState(
				target,
				state,
				undefined,
				sessionRecord,
			))
		) {
			return { updated: false };
		}
		const current = await this.invokeOptionalValue<SessionCompactionState>(
			"readSessionCompactionState",
			target,
		);
		if (isIncomingCompactionStateStale(state, current)) {
			return { updated: false };
		}
		await this.invoke<void>("persistSessionCompactionState", target, state);
		return { updated: true };
	}

	async readSessionCompactionState(
		sessionId: string,
	): Promise<SessionCompactionState | undefined> {
		const target = sessionId.trim();
		if (!target) return undefined;
		const activeSession = this.sessions.get(target);
		if (activeSession) {
			for (;;) {
				const pendingWrite = activeSession.compactionStateWriteQueue;
				if (!pendingWrite) {
					return activeSession.compactionState;
				}
				await pendingWrite.catch(() => undefined);
			}
		}
		return await this.invokeOptionalValue<SessionCompactionState>(
			"readSessionCompactionState",
			target,
		);
	}

	isCompactionStateForSession(
		sessionId: string,
		state: SessionCompactionState,
		activeSession?: ActiveSession,
		sessionRecord?: SessionRecord,
	): boolean {
		const conversationId = state.conversation_id?.trim();
		if (!conversationId) {
			return true;
		}
		if (conversationId === sessionId) {
			return true;
		}
		const expectedConversationId =
			activeSession?.agent.getConversationId()?.trim() ||
			sessionRecord?.conversationId?.trim();
		return expectedConversationId
			? conversationId === expectedConversationId
			: false;
	}

	private async canPersistCompactionState(
		sessionId: string,
		state: SessionCompactionState,
		activeSession?: ActiveSession,
		sessionRecord?: SessionRecord,
		sourceMessages?: readonly LlmsProviders.Message[],
	): Promise<boolean> {
		if (!state.conversation_id?.trim()) {
			return false;
		}
		if (
			!this.isCompactionStateForSession(
				sessionId,
				state,
				activeSession,
				sessionRecord,
			)
		) {
			return false;
		}
		const messagesForProjection =
			sourceMessages ??
			activeSession?.agent.getMessages() ??
			(await this.readSessionMessages(sessionId));
		return (
			projectSessionCompactionState(state, messagesForProjection) !== undefined
		);
	}

	async persistActiveSessionCompactionState(
		session: ActiveSession,
		state: SessionCompactionState,
		sourceMessages?: readonly LlmsProviders.Message[],
	): Promise<{ updated: boolean }> {
		if (
			!(await this.canPersistCompactionState(
				session.sessionId,
				state,
				session,
				undefined,
				sourceMessages,
			))
		) {
			return { updated: false };
		}
		return await this.enqueueCompactionStateWrite(session, async () => {
			const currentState = session.compactionState;
			const currentStateStillProjects =
				currentState !== undefined &&
				projectSessionCompactionState(
					currentState,
					sourceMessages ?? session.agent.getMessages(),
				) !== undefined;
			// The count-based stale guard exists to stop an old write from
			// clobbering a newer one, which only makes sense while the stored
			// state is still valid. An unprojectable state (e.g. invalidated by
			// message-identity churn on resume, or a hash-format change) must
			// not permanently block its replacement, so fall back to comparing
			// timestamps and let the newer state win.
			if (
				currentState &&
				(currentStateStillProjects
					? isIncomingCompactionStateStale(state, currentState)
					: Date.parse(state.updated_at) < Date.parse(currentState.updated_at))
			) {
				return { updated: false };
			}
			await this.invoke<void>(
				"persistSessionCompactionState",
				session.sessionId,
				state,
			);
			session.compactionState = state;
			return { updated: true };
		});
	}

	private async enqueueCompactionStateWrite<T>(
		session: ActiveSession,
		action: () => Promise<T>,
	): Promise<T> {
		const previous = session.compactionStateWriteQueue ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(action);
		const tracked = run.then(
			() => undefined,
			() => undefined,
		);
		session.compactionStateWriteQueue = tracked;
		try {
			return await run;
		} finally {
			if (session.compactionStateWriteQueue === tracked) {
				session.compactionStateWriteQueue = undefined;
			}
		}
	}
}

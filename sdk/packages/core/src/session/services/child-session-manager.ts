import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type * as LlmsProviders from "@plinycode/llms";
import type { AgentResult } from "@plinycode/shared";
import { resolveRootSessionId } from "@plinycode/shared";
import { ensureHookLogDir } from "@plinycode/shared/storage";
import { z } from "zod";
import type {
	SubAgentEndContext,
	SubAgentStartContext,
} from "../../extensions/tools/team";
import type { HookEventPayload } from "../../hooks";
import { nowIso } from "../../services/session-artifacts";
import { resolveMetadataWithTitle } from "../../services/session-data";
import {
	isNonTerminalSessionStatus,
	type SessionStatus,
	type TerminalSessionStatus,
} from "../../types/common";
import type {
	SessionPersistenceAdapter,
	StoredMessageWithMetadata,
} from "../../types/session";
import {
	readSessionHistoryOriginMetadata,
	withSessionHistoryOriginMetadata,
} from "../history-origin";
import {
	deriveSubsessionStatus,
	makeSubSessionId,
} from "../models/session-graph";
import type { SessionRow, UpsertSubagentInput } from "../models/session-row";
import type { SessionManifestStore } from "../stores/session-manifest-store";

const SpawnAgentInputSchema = z.looseObject({
	task: z.string().optional(),
	systemPrompt: z.string().optional(),
});

/**
 * Records sub-agent runs as child session rows under their root session and
 * keeps their status and message files in step with the run.
 */
export class ChildSessionManager {
	constructor(
		private readonly adapter: SessionPersistenceAdapter,
		private readonly manifestStore: SessionManifestStore,
		private readonly toPersistedMessages: (
			messages: LlmsProviders.MessageWithMetadata[] | undefined,
			result?: AgentResult,
			previousMessages?: LlmsProviders.MessageWithMetadata[],
		) => StoredMessageWithMetadata[] | undefined,
	) {}

	private buildSubsessionRow(
		root: SessionRow,
		opts: {
			sessionId: string;
			parentSessionId: string;
			parentAgentId: string;
			agentId: string;
			conversationId?: string | null;
			prompt: string;
			startedAt: string;
			messagesPath: string;
		},
	): SessionRow {
		const rootHistoryOrigin = readSessionHistoryOriginMetadata(root.metadata);
		return {
			sessionId: opts.sessionId,
			source: root.source,
			pid: root.pid,
			startedAt: opts.startedAt,
			endedAt: null,
			exitCode: null,
			status: "running",
			statusLock: 0,
			interactive: false,
			provider: root.provider,
			model: root.model,
			cwd: root.cwd,
			workspaceRoot: root.workspaceRoot,
			enableTools: root.enableTools,
			enableSpawn: root.enableSpawn,
			parentSessionId: opts.parentSessionId,
			parentAgentId: opts.parentAgentId,
			agentId: opts.agentId,
			conversationId: opts.conversationId ?? null,
			isSubagent: true,
			prompt: opts.prompt,
			metadata: resolveMetadataWithTitle({
				metadata: withSessionHistoryOriginMetadata(undefined, {
					mode: "subagent",
					version: rootHistoryOrigin?.version,
				}),
				prompt: opts.prompt,
			}),
			hookPath: "",
			messagesPath: opts.messagesPath,
			updatedAt: opts.startedAt,
		};
	}

	async queueSpawnRequest(event: HookEventPayload): Promise<void> {
		if (event.hookName !== "tool_call" || event.parent_agent_id !== null)
			return;
		if (event.tool_call?.name !== "spawn_agent") return;

		const rootSessionId = resolveRootSessionId(event.sessionContext);
		if (!rootSessionId) return;

		const parsed = SpawnAgentInputSchema.safeParse(event.tool_call.input);
		await this.adapter.enqueueSpawnRequest({
			rootSessionId,
			parentAgentId: event.agent_id,
			task: parsed.success ? parsed.data.task : undefined,
			systemPrompt: parsed.success ? parsed.data.systemPrompt : undefined,
		});
	}

	async upsertSubagentSession(
		input: UpsertSubagentInput,
	): Promise<string | undefined> {
		const rootSessionId = input.rootSessionId;
		if (!rootSessionId) return undefined;

		const root = await this.adapter.getSession(rootSessionId);
		if (!root) return undefined;

		const sessionId = makeSubSessionId(rootSessionId, input.agentId);
		const existing = await this.adapter.getSession(sessionId);
		const startedAt = nowIso();
		const artifactPaths =
			this.manifestStore.artifacts.subagentArtifactPaths(sessionId);

		let prompt = input.prompt ?? existing?.prompt ?? undefined;
		if (!prompt) {
			prompt =
				(await this.adapter.claimSpawnRequest(
					rootSessionId,
					input.parentAgentId,
				)) ?? `Subagent run by ${input.parentAgentId}`;
		}

		if (!existing) {
			const row = this.buildSubsessionRow(root, {
				sessionId,
				parentSessionId: rootSessionId,
				parentAgentId: input.parentAgentId,
				agentId: input.agentId,
				conversationId: input.conversationId,
				prompt,
				startedAt,
				...artifactPaths,
			});
			await this.adapter.upsertSession(row);
			this.manifestStore.initializeMessagesFile(
				row,
				artifactPaths.messagesPath,
				startedAt,
			);
			return sessionId;
		}

		await this.adapter.updateSession({
			sessionId,
			setRunning: true,
			parentSessionId: rootSessionId,
			parentAgentId: input.parentAgentId,
			agentId: input.agentId,
			conversationId: input.conversationId,
			prompt: existing.prompt ?? prompt ?? null,
			metadata: resolveMetadataWithTitle({
				metadata: withSessionHistoryOriginMetadata(existing.metadata, {
					mode: "subagent",
					version: readSessionHistoryOriginMetadata(root.metadata)?.version,
				}),
				prompt: existing.prompt ?? prompt ?? null,
			}),
			expectedStatusLock: existing.statusLock,
		});
		return sessionId;
	}

	async upsertSubagentSessionFromHook(
		event: HookEventPayload,
	): Promise<string | undefined> {
		if (!event.parent_agent_id) return undefined;
		const rootSessionId = resolveRootSessionId(event.sessionContext);
		if (!rootSessionId) return undefined;
		if (event.hookName === "session_shutdown") {
			const sessionId = makeSubSessionId(rootSessionId, event.agent_id);
			const existing = await this.adapter.getSession(sessionId);
			return existing ? sessionId : undefined;
		}
		return await this.upsertSubagentSession({
			agentId: event.agent_id,
			parentAgentId: event.parent_agent_id,
			conversationId: event.taskId,
			rootSessionId,
		});
	}

	async applySubagentStatus(
		subSessionId: string,
		event: HookEventPayload,
	): Promise<void> {
		await this.applySubagentStatusBySessionId(
			subSessionId,
			deriveSubsessionStatus(event),
		);
	}

	async applySubagentStatusBySessionId(
		subSessionId: string,
		status: SessionStatus,
	): Promise<void> {
		const row = await this.adapter.getSession(subSessionId);
		if (!row) return;
		const endedAt = isNonTerminalSessionStatus(status) ? null : nowIso();
		const exitCode = isNonTerminalSessionStatus(status)
			? null
			: status === "failed"
				? 1
				: 0;
		await this.adapter.updateSession({
			sessionId: subSessionId,
			status,
			endedAt,
			exitCode,
			expectedStatusLock: row.statusLock,
		});
	}

	async applyStatusToRunningChildSessions(
		parentSessionId: string,
		status: TerminalSessionStatus,
	): Promise<void> {
		if (!parentSessionId) return;
		const rows = await this.adapter.listSessions({
			limit: 2000,
			parentSessionId,
			status: "running",
		});
		for (const row of rows) {
			await this.applySubagentStatusBySessionId(row.sessionId, status);
		}
	}

	async handleSubAgentStart(
		rootSessionId: string,
		context: SubAgentStartContext,
	): Promise<void> {
		const subSessionId = await this.upsertSubagentSession({
			agentId: context.subAgentId,
			parentAgentId: context.parentAgentId,
			conversationId: context.conversationId,
			prompt: context.input.task,
			rootSessionId,
		});
		if (!subSessionId) return;
		await this.applySubagentStatusBySessionId(subSessionId, "running");
	}

	async handleSubAgentEnd(
		rootSessionId: string,
		context: SubAgentEndContext,
	): Promise<void> {
		const subSessionId = await this.upsertSubagentSession({
			agentId: context.subAgentId,
			parentAgentId: context.parentAgentId,
			conversationId: context.conversationId,
			prompt: context.input.task,
			rootSessionId,
		});
		if (!subSessionId) return;
		if (context.error) {
			await this.applySubagentStatusBySessionId(subSessionId, "failed");
			return;
		}
		const persistedMessages = this.toPersistedMessages(
			context.agentResult?.messages,
			context.agentResult,
		);
		if (persistedMessages) {
			await this.manifestStore.persistSessionMessages(
				subSessionId,
				persistedMessages,
			);
		}
		const reason = context.result?.finishReason ?? "completed";
		await this.applySubagentStatusBySessionId(
			subSessionId,
			reason === "aborted" ? "cancelled" : "completed",
		);
	}

	appendSubagentHookAudit(event: HookEventPayload): void {
		const envPath = process.env.CLINE_HOOKS_LOG_PATH?.trim() || undefined;
		const logPath = envPath ?? join(ensureHookLogDir(), "hooks.jsonl");
		appendFileSync(
			logPath,
			`${JSON.stringify({ ts: nowIso(), ...event })}\n`,
			"utf8",
		);
	}
}

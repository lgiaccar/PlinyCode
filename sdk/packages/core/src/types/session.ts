import type * as LlmsProviders from "@plinycode/llms";
import type { AgentFinishReason } from "@plinycode/shared";
import type { SessionAccumulatedUsage } from "../runtime/host/runtime-host";
import type { BuiltRuntime } from "../runtime/orchestration/session-runtime";
import type { SessionRuntime } from "../runtime/orchestration/session-runtime-orchestrator";
import type { SessionCompactionState } from "../session/models/session-compaction";
import type { SessionRow } from "../session/models/session-row";
import type { RootSessionArtifacts } from "../session/services/session-service";
import type { SessionSource, SessionStatus } from "./common";
import type { CoreAgentMode, CoreSessionConfig } from "./config";

export type ActiveSession = {
	sessionId: string;
	config: CoreSessionConfig;
	sessionMetadata?: Record<string, unknown>;
	artifacts?: RootSessionArtifacts;
	source: SessionSource;
	startedAt: string;
	updatedAt: string;
	status: SessionStatus;
	endedAt?: string | null;
	exitCode?: number | null;
	pendingPrompt?: string;
	runtime: BuiltRuntime;
	agent: SessionRuntime;
	started: boolean;
	aborting: boolean;
	interactive: boolean;
	persistedMessages?: LlmsProviders.MessageWithMetadata[];
	compactionState?: SessionCompactionState;
	compactionStateWriteQueue?: Promise<void>;
	pendingPrompts: PendingPrompt[];
	drainingPendingPrompts: boolean;
	pluginSandboxShutdown?: () => Promise<void>;
	turnUsageBaseline?: SessionAccumulatedUsage;
	turnAggregateUsageBaseline?: SessionAccumulatedUsage;
	turnPrimaryUsage?: SessionAccumulatedUsage;
	turnUsageByAgent?: Map<string, SessionAccumulatedUsage>;
	/** Sub-agents of this turn whose usage was settled from their result. */
	turnSettledAgents?: Set<string>;
	lastInteractiveTurnFinishReason?: AgentFinishReason;
};

export type PendingPrompt = {
	id: string;
	prompt: string;
	mode?: CoreAgentMode;
	delivery: "queue" | "steer";
	userImages?: string[];
	userFiles?: string[];
};

export type StoredMessageWithMetadata = LlmsProviders.MessageWithMetadata;

export type PreparedTurnInput = {
	prompt: string;
	userImages?: string[];
	userFiles?: string[];
};

// ── Persistence interfaces ────────────────────────────────────────────

export interface PersistedSessionUpdateInput {
	sessionId: string;
	expectedStatusLock?: number;
	status?: SessionStatus;
	endedAt?: string | null;
	exitCode?: number | null;
	prompt?: string | null;
	metadata?: Record<string, unknown> | null;
	title?: string | null;
	parentSessionId?: string | null;
	parentAgentId?: string | null;
	agentId?: string | null;
	conversationId?: string | null;
	setRunning?: boolean;
}

export interface SessionPersistenceAdapter {
	ensureSessionsDir(): string;
	upsertSession(row: SessionRow): Promise<void>;
	getSession(sessionId: string): Promise<SessionRow | undefined>;
	listSessions(options: {
		limit: number;
		parentSessionId?: string;
		status?: string;
		/** Only root sessions: excludes sub-agent child rows. */
		rootOnly?: boolean;
	}): Promise<SessionRow[]>;
	updateSession(
		input: PersistedSessionUpdateInput,
	): Promise<{ updated: boolean; statusLock: number }>;
	deleteSession(sessionId: string, cascade: boolean): Promise<boolean>;
	enqueueSpawnRequest(input: {
		rootSessionId: string;
		parentAgentId: string;
		task?: string;
		systemPrompt?: string;
	}): Promise<void>;
	claimSpawnRequest(
		rootSessionId: string,
		parentAgentId: string,
	): Promise<string | undefined>;
}

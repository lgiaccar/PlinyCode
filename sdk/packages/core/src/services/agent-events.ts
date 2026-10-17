import type { AgentEvent } from "@plinycode/shared";
import type { SessionAccumulatedUsage } from "../runtime/host/runtime-host";
import type { CoreSessionConfig } from "../types/config";
import type { CoreSessionEvent } from "../types/events";
import type { ActiveSession } from "../types/session";
import { serializeAgentEvent } from "./session-data";
import {
	accumulateUsageTotals,
	createInitialAccumulatedUsage,
	sumUsageTotals,
} from "./usage";

export interface AgentEventContext {
	sessionId: string;
	config: CoreSessionConfig;
	liveSession: ActiveSession | undefined;
	usageBySession: Map<string, SessionAccumulatedUsage>;
	aggregateUsageBySession: Map<string, SessionAccumulatedUsage>;
	persistMessages: (
		sessionId: string,
		messages: unknown[],
		systemPrompt?: string,
	) => void;
	emit: (event: CoreSessionEvent) => void;
}

/**
 * Which agent an event came from, when the caller knows better than the
 * event's own metadata. Drives per-agent usage accounting.
 */
export interface AgentEventContextOverrides {
	agentId?: string;
	isPrimaryAgentEvent?: boolean;
}

export function extractAgentEventMetadata(event: AgentEvent): {
	agentId?: string;
	conversationId?: string;
	parentAgentId?: string;
} {
	if (!event || typeof event !== "object") {
		return {};
	}
	const record = event as unknown as Record<string, unknown>;
	return {
		agentId: typeof record.agentId === "string" ? record.agentId : undefined,
		conversationId:
			typeof record.conversationId === "string"
				? record.conversationId
				: undefined,
		parentAgentId:
			typeof record.parentAgentId === "string"
				? record.parentAgentId
				: undefined,
	};
}

function usageDeltaFromEvent(event: Extract<AgentEvent, { type: "usage" }>) {
	return {
		inputTokens: event.inputTokens,
		outputTokens: event.outputTokens,
		cacheWriteTokens: event.cacheWriteTokens,
		cacheReadTokens: event.cacheReadTokens,
		totalCost: event.cost,
	};
}

function resolveUsageAgentKey(input: {
	isPrimaryAgentEvent: boolean;
	overrides?: AgentEventContextOverrides;
	eventMetadata: ReturnType<typeof extractAgentEventMetadata>;
}): string {
	const candidates = input.isPrimaryAgentEvent
		? [input.overrides?.agentId, input.eventMetadata.agentId]
		: [
				input.overrides?.agentId,
				input.eventMetadata.agentId,
				input.eventMetadata.conversationId,
			];
	for (const candidate of candidates) {
		const value = candidate?.trim();
		if (value) return value;
	}
	return input.isPrimaryAgentEvent ? "root" : "unknown";
}

/**
 * The session's aggregate usage (root agent plus sub-agents) from the
 * turn's baseline and what the turn has used so far.
 */
function refreshTurnAggregateUsage(
	ctx: Pick<AgentEventContext, "sessionId" | "aggregateUsageBySession">,
	liveSession: ActiveSession,
): void {
	if (!liveSession.turnUsageBaseline) {
		return;
	}
	const aggregateTurnUsage = accumulateUsageTotals(
		liveSession.turnPrimaryUsage ?? createInitialAccumulatedUsage(),
		sumUsageTotals(liveSession.turnUsageByAgent?.values() ?? []),
	);
	ctx.aggregateUsageBySession.set(
		ctx.sessionId,
		accumulateUsageTotals(
			liveSession.turnAggregateUsageBaseline ?? liveSession.turnUsageBaseline,
			aggregateTurnUsage,
		),
	);
}

/**
 * Settles a finished sub-agent's usage into the session's aggregate the
 * moment it ends, from the run's own totals. The figures replace whatever
 * its live usage events added, so a sub-agent is counted once however many
 * of its events arrived, and a repeated end changes nothing. The turn's end
 * then writes the aggregate to the session metadata, which a resume reads
 * back as the floor of the re-aggregated usage. Returns false when the
 * session has no turn running (a sub-agent only runs inside one).
 */
export function settleSubAgentUsage(
	ctx: Pick<
		AgentEventContext,
		"sessionId" | "liveSession" | "aggregateUsageBySession"
	>,
	subAgentId: string,
	usage: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		totalCost?: number;
	},
): boolean {
	const liveSession = ctx.liveSession;
	const agentKey = subAgentId.trim();
	if (!liveSession?.turnUsageBaseline || !agentKey) {
		return false;
	}
	const turnUsageByAgent =
		liveSession.turnUsageByAgent ?? new Map<string, SessionAccumulatedUsage>();
	liveSession.turnUsageByAgent = turnUsageByAgent;
	turnUsageByAgent.set(
		agentKey,
		accumulateUsageTotals(createInitialAccumulatedUsage(), usage),
	);
	const settled = liveSession.turnSettledAgents ?? new Set<string>();
	liveSession.turnSettledAgents = settled;
	settled.add(agentKey);
	refreshTurnAggregateUsage(ctx, liveSession);
	return true;
}

export function handleAgentEvent(
	ctx: AgentEventContext,
	event: AgentEvent,
	overrides?: AgentEventContextOverrides,
): void {
	const { sessionId, liveSession, emit } = ctx;
	const isPrimaryAgentEvent = overrides?.isPrimaryAgentEvent ?? true;
	const eventMetadata = extractAgentEventMetadata(event);

	if (event.type === "usage" && liveSession?.turnUsageBaseline) {
		const usageDelta = usageDeltaFromEvent(event);
		if (isPrimaryAgentEvent) {
			liveSession.turnPrimaryUsage = accumulateUsageTotals(
				liveSession.turnPrimaryUsage ?? createInitialAccumulatedUsage(),
				usageDelta,
			);
			const mainUsage = accumulateUsageTotals(
				liveSession.turnUsageBaseline,
				liveSession.turnPrimaryUsage,
			);
			ctx.usageBySession.set(sessionId, mainUsage);
		} else {
			const agentKey = resolveUsageAgentKey({
				isPrimaryAgentEvent,
				overrides,
				eventMetadata,
			});
			// A finished sub-agent's usage was settled from its result; a late
			// event of its own must not add to it again.
			if (!liveSession.turnSettledAgents?.has(agentKey)) {
				const turnUsageByAgent =
					liveSession.turnUsageByAgent ??
					new Map<string, SessionAccumulatedUsage>();
				liveSession.turnUsageByAgent = turnUsageByAgent;
				turnUsageByAgent.set(
					agentKey,
					accumulateUsageTotals(
						turnUsageByAgent.get(agentKey) ?? createInitialAccumulatedUsage(),
						usageDelta,
					),
				);
			}
		}
		refreshTurnAggregateUsage(ctx, liveSession);
	}

	if (event.type === "iteration_end" && isPrimaryAgentEvent) {
		ctx.persistMessages(
			sessionId,
			liveSession?.agent.getMessages() ?? [],
			liveSession?.config.systemPrompt,
		);
	}

	emit({
		type: "agent_event",
		payload: { sessionId, event },
	});
	emit({
		type: "chunk",
		payload: {
			sessionId,
			stream: "agent",
			chunk: serializeAgentEvent(event),
			ts: Date.now(),
		},
	});
}

import type {
	AgentEvent,
	AutomationEventEnvelope,
	BasicLogger,
	BasicLogMetadata,
} from "@plinycode/shared";
import type { TeamEvent } from "../../../extensions/tools/team";
import {
	type AgentEventContext,
	type AgentEventContextOverrides,
	extractAgentEventMetadata,
	handleAgentEvent,
} from "../../../services/agent-events";
import {
	dispatchTeamEventToBackend,
	emitTeamProgress,
	trackTeamRunState,
} from "../../../session/team";
import type { CoreSessionConfig } from "../../../types/config";
import type { CoreSessionEvent } from "../../../types/events";
import type { ActiveSession } from "../../../types/session";
import type { SessionRuntime } from "../../orchestration/session-runtime-orchestrator";
import type { SessionAccumulatedUsage } from "../runtime-host";

export interface AgentEventBridgeDeps {
	getSession(sessionId: string): ActiveSession | undefined;
	usageBySession: Map<string, SessionAccumulatedUsage>;
	aggregateUsageBySession: Map<string, SessionAccumulatedUsage>;
	emit(event: CoreSessionEvent): void;
	persistMessages: AgentEventContext["persistMessages"];
	enqueuePendingPrompt(
		sessionId: string,
		entry: { prompt: string; delivery: "queue" | "steer" },
	): void;
	invokeBackendOptional(method: string, ...args: unknown[]): Promise<void>;
}

export class AgentEventBridge {
	constructor(private readonly deps: AgentEventBridgeDeps) {}

	/**
	 * Last agent identity stamped on each session's events while the session
	 * was still registered. A session's agent can keep emitting after the host
	 * removes it from the sessions map (teardown deletes the entry before the
	 * run fully drains), and without this snapshot those late events reach
	 * clients with no agent identity at all. Bounded FIFO so a long-lived
	 * host doesn't accumulate entries forever.
	 */
	private readonly lastKnownIdentityBySession = new Map<
		string,
		AgentEventContextOverrides
	>();
	private static readonly MAX_IDENTITY_SNAPSHOTS = 512;

	dispatchAgentEvent(
		sessionId: string,
		config: CoreSessionConfig,
		event: AgentEvent,
	): void {
		const liveSession = this.deps.getSession(sessionId);
		const ctx: AgentEventContext = {
			sessionId,
			config,
			liveSession,
			usageBySession: this.deps.usageBySession,
			aggregateUsageBySession: this.deps.aggregateUsageBySession,
			persistMessages: this.deps.persistMessages,
			emit: this.deps.emit,
		};
		const eventMetadata = extractAgentEventMetadata(event);
		const isRootAgentEvent =
			!!liveSession &&
			(!eventMetadata.agentId ||
				eventMetadata.agentId === readAgentId(liveSession.agent));
		if (isRootAgentEvent) {
			const identity: AgentEventContextOverrides = {
				agentId: readAgentId(liveSession.agent),
				...(liveSession?.runtime.teamRuntime
					? { teamRole: "lead" as const }
					: {}),
			};
			this.rememberSessionIdentity(sessionId, identity);
			handleAgentEvent(ctx, event, {
				...identity,
				isPrimaryAgentEvent: true,
			});
			return;
		}
		handleAgentEvent(ctx, event, {
			// Session-map miss: the session was already deregistered but its
			// agent is still emitting. Reuse the identity captured while it was
			// live so late events keep their agent and team role. When the
			// session IS live this is a non-root
			// (sub-agent) event carrying its own metadata, so no fallback is
			// applied.
			...(liveSession ? {} : this.lastKnownIdentityBySession.get(sessionId)),
			isPrimaryAgentEvent: false,
		});
	}

	private rememberSessionIdentity(
		sessionId: string,
		identity: AgentEventContextOverrides,
	): void {
		// Delete-then-set keeps insertion order acting as least-recently-updated
		// for the FIFO eviction below.
		this.lastKnownIdentityBySession.delete(sessionId);
		this.lastKnownIdentityBySession.set(sessionId, identity);
		if (
			this.lastKnownIdentityBySession.size >
			AgentEventBridge.MAX_IDENTITY_SNAPSHOTS
		) {
			const oldest = this.lastKnownIdentityBySession.keys().next().value;
			if (oldest !== undefined) {
				this.lastKnownIdentityBySession.delete(oldest);
			}
		}
	}

	async handleTeamEvent(
		rootSessionId: string,
		event: TeamEvent,
	): Promise<void> {
		const session = this.deps.getSession(rootSessionId);
		if (session) {
			trackTeamRunState(session, event);
			if (event.type === "agent_event") {
				const ctx: AgentEventContext = {
					sessionId: rootSessionId,
					config: session.config,
					liveSession: session,
					usageBySession: this.deps.usageBySession,
					aggregateUsageBySession: this.deps.aggregateUsageBySession,
					persistMessages: this.deps.persistMessages,
					emit: this.deps.emit,
				};
				handleAgentEvent(ctx, event.event, {
					agentId: event.agentId,
					teamRole: "teammate",
					teamAgentId: event.agentId,
					isPrimaryAgentEvent: false,
				});
			}
		}

		await dispatchTeamEventToBackend(
			rootSessionId,
			event,
			this.deps.invokeBackendOptional,
		);

		if (session) {
			emitTeamProgress(session, rootSessionId, event, this.deps.emit);
		}
	}

	async handlePluginEvent(
		rootSessionId: string,
		event: { name: string; payload?: unknown },
		fallbackAutomation?: NonNullable<
			CoreSessionConfig["extensionContext"]
		>["automation"],
	): Promise<void> {
		if (event.name === "plugin_log") {
			this.handlePluginLog(rootSessionId, event.payload);
			return;
		}
		if (event.name === "automation_event") {
			const session = this.deps.getSession(rootSessionId);
			const automation =
				session?.config.extensionContext?.automation ?? fallbackAutomation;
			if (!automation) return;
			const payload =
				event.payload && typeof event.payload === "object"
					? (event.payload as AutomationEventEnvelope)
					: undefined;
			if (!payload) return;
			await automation.ingestEvent(payload);
			return;
		}
		if (
			event.name !== "steer_message" &&
			event.name !== "queue_message" &&
			event.name !== "pending_prompt"
		) {
			return;
		}
		const payload =
			event.payload && typeof event.payload === "object"
				? (event.payload as Record<string, unknown>)
				: undefined;
		const targetSessionId =
			typeof payload?.sessionId === "string" &&
			payload.sessionId.trim().length > 0
				? payload.sessionId.trim()
				: rootSessionId;
		const prompt =
			typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
		if (!prompt) return;
		const delivery: "queue" | "steer" =
			event.name === "steer_message"
				? "steer"
				: event.name === "queue_message"
					? "queue"
					: payload?.delivery === "steer"
						? "steer"
						: "queue";
		this.deps.enqueuePendingPrompt(targetSessionId, { prompt, delivery });
	}

	handlePluginLog(
		rootSessionId: string,
		payload: unknown,
		fallbackLogger?: BasicLogger,
	): void {
		const session = this.deps.getSession(rootSessionId);
		const logger =
			fallbackLogger ??
			session?.config.extensionContext?.logger ??
			session?.config.logger;
		if (!logger || !payload || typeof payload !== "object") return;
		const record = payload as Record<string, unknown>;
		const message = typeof record.message === "string" ? record.message : "";
		if (!message) return;
		const metadata =
			record.metadata && typeof record.metadata === "object"
				? ({
						...(record.metadata as Record<string, unknown>),
					} as BasicLogMetadata)
				: {};
		metadata.sessionId ??= rootSessionId;
		if (typeof record.pluginName === "string" && record.pluginName) {
			metadata.pluginName = record.pluginName;
		}
		if (record.level === "debug") {
			logger.debug(message, metadata);
			return;
		}
		if (record.level === "error") {
			if (logger.error) {
				logger.error(message, metadata);
			} else {
				logger.log(message, { ...metadata, severity: "error" });
			}
			return;
		}
		logger.log(message, metadata);
	}
}

function readAgentId(agent: SessionRuntime): string {
	return agent.getAgentId();
}

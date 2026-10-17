import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageWithMetadata } from "@plinycode/llms";
import type { AgentEvent, AgentResult } from "@plinycode/shared";
import { setClineDir, setHomeDir } from "@plinycode/shared/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAgentEndContext } from "../../../extensions/tools/team";
import type { SessionManifest } from "../../../session/models/session-manifest";
import { SessionSource } from "../../../types/common";
import type { CoreSessionConfig } from "../../../types/config";
import { LocalRuntimeHost } from "../local-runtime-host";
import {
	type StartSessionInput,
	splitCoreSessionConfig,
} from "../runtime-host";

const ROOT_AGENT_ID = "agent-root-1";
const SUB_AGENT_ID = "sub-agent-1";

type SubAgentCallbacks = {
	onSubAgentEvent?: (event: AgentEvent) => void;
	onSubAgentEnd?: (context: SubAgentEndContext) => void;
};

function result(overrides: Partial<AgentResult> = {}): AgentResult {
	return {
		text: "ok",
		iterations: 1,
		finishReason: "completed",
		usage: { inputTokens: 3, outputTokens: 4, totalCost: 0.42 },
		messages: [],
		toolCalls: [],
		durationMs: 1,
		model: { id: "mock-model", provider: "mock-provider" },
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		endedAt: new Date("2026-01-01T00:00:01.000Z"),
		...overrides,
	};
}

function startInput(
	config: CoreSessionConfig,
	rest: Omit<StartSessionInput, "config" | "localRuntime">,
): StartSessionInput {
	return { ...rest, ...splitCoreSessionConfig(config) };
}

function config(sessionId: string): CoreSessionConfig {
	return {
		sessionId,
		providerId: "mock-provider",
		modelId: "mock-model",
		cwd: "/tmp/project",
		systemPrompt: "You are a test agent",
		mode: "act",
		enableTools: true,
		enableSpawnAgent: true,
	};
}

/** The sub-agent's usage event as its progress reporter forwards it: tagged with its id. */
const subAgentUsageEvent = {
	type: "usage",
	inputTokens: 40,
	outputTokens: 10,
	cacheReadTokens: 5,
	cost: 0.2,
	totalInputTokens: 40,
	totalOutputTokens: 10,
	agentId: SUB_AGENT_ID,
	parentAgentId: ROOT_AGENT_ID,
} as AgentEvent;

const subAgentEnd: SubAgentEndContext = {
	subAgentId: SUB_AGENT_ID,
	conversationId: "conv-sub-1",
	parentAgentId: ROOT_AGENT_ID,
	input: { task: "look around" },
	usage: {
		inputTokens: 40,
		outputTokens: 10,
		cacheReadTokens: 5,
		cacheWriteTokens: 0,
		totalCost: 0.2,
	},
};

function agent(run: () => Promise<AgentResult>, messages: unknown[] = []) {
	return {
		run,
		continue: run,
		abort: vi.fn(),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		canStartRun: vi.fn().mockReturnValue(true),
		getAgentId: vi.fn().mockReturnValue(ROOT_AGENT_ID),
		getConversationId: vi.fn().mockReturnValue("conv-root-1"),
		shutdown: vi.fn().mockResolvedValue(undefined),
		getMessages: vi.fn().mockReturnValue(messages),
		messages,
	};
}

describe("sub-agent usage in the session's accumulated usage", () => {
	const envSnapshot = {
		HOME: process.env.HOME,
		CLINE_DIR: process.env.CLINE_DIR,
	};
	let homeDir = "";
	let sessionsDir = "";

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "core-subagent-usage-"));
		sessionsDir = join(homeDir, "sessions");
		process.env.HOME = homeDir;
		process.env.CLINE_DIR = join(homeDir, ".cline");
		setHomeDir(homeDir);
		setClineDir(process.env.CLINE_DIR);
	});

	afterEach(() => {
		process.env.HOME = envSnapshot.HOME;
		process.env.CLINE_DIR = envSnapshot.CLINE_DIR;
		setHomeDir(envSnapshot.HOME ?? "~");
		setClineDir(envSnapshot.CLINE_DIR ?? join("~", ".cline"));
		rmSync(homeDir, { recursive: true, force: true });
	});

	function manifest(sessionId: string): SessionManifest {
		return {
			version: 1,
			session_id: sessionId,
			source: SessionSource.CLI,
			pid: process.pid,
			started_at: "2026-01-01T00:00:00.000Z",
			status: "running",
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspace_root: "/tmp/project",
			enable_tools: true,
			enable_spawn: true,
			prompt: "hello",
			messages_path: join(sessionsDir, sessionId, `${sessionId}.messages.json`),
		};
	}

	function host(
		sessionService: Record<string, unknown>,
		run: () => Promise<AgentResult>,
		messages: unknown[] = [],
	) {
		const callbacks: SubAgentCallbacks = {};
		const manager = new LocalRuntimeHost({
			distinctId: "test-distinct-id",
			sessionService: sessionService as never,
			runtimeBuilder: {
				build: vi.fn().mockImplementation((input: SubAgentCallbacks) => {
					callbacks.onSubAgentEvent = input.onSubAgentEvent;
					callbacks.onSubAgentEnd = input.onSubAgentEnd;
					return { tools: [], shutdown: vi.fn() };
				}),
			},
			createAgent: () => agent(run, messages) as never,
		});
		return { manager, callbacks };
	}

	function newSessionService(sessionId: string) {
		const sessionManifest = manifest(sessionId);
		mkdirSync(join(sessionsDir, sessionId), { recursive: true });
		const updateSession = vi.fn().mockResolvedValue({ updated: true });
		return {
			updateSession,
			service: {
				ensureSessionsDir: vi.fn().mockReturnValue(sessionsDir),
				createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
					manifestPath: join(sessionsDir, sessionId, `${sessionId}.json`),
					messagesPath: sessionManifest.messages_path,
					manifest: sessionManifest,
				}),
				persistSessionMessages: vi.fn(),
				updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
				updateSession,
				writeSessionManifest: vi.fn(),
				listSessions: vi.fn().mockResolvedValue([]),
				deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
			},
		};
	}

	it("counts a finished sub-agent once at turn end, however many of its events arrive", async () => {
		const sessionId = "sess-subagent-usage";
		const { service, updateSession } = newSessionService(sessionId);
		let callbacks: SubAgentCallbacks = {};
		const run = vi.fn(async () => {
			callbacks.onSubAgentEvent?.(subAgentUsageEvent);
			callbacks.onSubAgentEnd?.(subAgentEnd);
			// A repeated end and a late event of the same sub-agent change nothing.
			callbacks.onSubAgentEnd?.(subAgentEnd);
			callbacks.onSubAgentEvent?.(subAgentUsageEvent);
			return result();
		});
		const built = host(service, run);
		callbacks = built.callbacks;

		await built.manager.startSession(
			startInput(config(sessionId), { prompt: "hello", interactive: false }),
		);

		const metadata = updateSession.mock.calls.at(-1)?.[0].metadata as Record<
			string,
			unknown
		>;
		// The root agent's own usage stays root-only; the aggregate adds the sub-agent.
		expect(metadata.totalCost as number).toBeCloseTo(0.42);
		expect(metadata.aggregatedAgentsCost as number).toBeCloseTo(0.62);
		expect(metadata.aggregateUsage).toMatchObject({
			inputTokens: 43,
			outputTokens: 14,
			cacheReadTokens: 5,
		});
		expect(
			(await built.manager.getAccumulatedUsage(sessionId))?.aggregateUsage
				?.totalCost,
		).toBeCloseTo(0.62);
	});

	it("settles a sub-agent from its result when its live events were missed", async () => {
		const sessionId = "sess-subagent-settle-only";
		const { service, updateSession } = newSessionService(sessionId);
		let callbacks: SubAgentCallbacks = {};
		const built = host(service, async () => {
			callbacks.onSubAgentEnd?.(subAgentEnd);
			return result();
		});
		callbacks = built.callbacks;

		await built.manager.startSession(
			startInput(config(sessionId), { prompt: "hello", interactive: false }),
		);

		const metadata = updateSession.mock.calls.at(-1)?.[0].metadata as Record<
			string,
			unknown
		>;
		expect(metadata.aggregatedAgentsCost as number).toBeCloseTo(0.62);
	});

	it("keeps a sub-agent's usage when the turn fails after it", async () => {
		const sessionId = "sess-subagent-failed-turn";
		const { service, updateSession } = newSessionService(sessionId);
		let callbacks: SubAgentCallbacks = {};
		const built = host(service, async () => {
			callbacks.onSubAgentEvent?.(subAgentUsageEvent);
			callbacks.onSubAgentEnd?.(subAgentEnd);
			throw new Error("provider failed");
		});
		callbacks = built.callbacks;

		await built.manager
			.startSession(
				startInput(config(sessionId), { prompt: "hello", interactive: false }),
			)
			.catch(() => undefined);

		const writes = updateSession.mock.calls.map(
			(call) => call[0].metadata as Record<string, unknown>,
		);
		const usageWrite = writes.find(
			(metadata) => metadata?.aggregatedAgentsCost !== undefined,
		);
		expect(usageWrite?.aggregatedAgentsCost as number).toBeCloseTo(0.2);
	});

	it("does not count the sub-agent again when a resumed session re-aggregates its usage", async () => {
		const sessionId = "sess-subagent-resume";
		const sessionDir = join(sessionsDir, sessionId);
		mkdirSync(sessionDir, { recursive: true });
		// The sub-agent's own transcript, which a resume reads beside the root's.
		writeFileSync(
			join(sessionDir, `${SUB_AGENT_ID}.messages.json`),
			`${JSON.stringify({
				version: 1,
				messages: [
					{
						role: "assistant",
						content: "report",
						metrics: {
							inputTokens: 40,
							outputTokens: 10,
							cacheReadTokens: 5,
							cacheWriteTokens: 0,
							cost: 0.2,
						},
					},
				],
			})}\n`,
			"utf8",
		);
		const aggregateUsage = {
			inputTokens: 43,
			outputTokens: 14,
			cacheReadTokens: 5,
			cacheWriteTokens: 0,
			totalCost: 0.62,
		};
		const persisted = {
			...manifest(sessionId),
			status: "completed" as const,
			ended_at: "2026-01-01T00:03:00.000Z",
			metadata: {
				totalCost: 0.42,
				aggregatedAgentsCost: 0.62,
				usage: {
					...aggregateUsage,
					inputTokens: 3,
					outputTokens: 4,
					cacheReadTokens: 0,
					totalCost: 0.42,
				},
				aggregateUsage,
			},
		};
		const initialMessages: MessageWithMetadata[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "ok",
				metrics: { inputTokens: 3, outputTokens: 4, cost: 0.42 },
			},
		];
		const updateSession = vi.fn().mockResolvedValue({ updated: true });
		const service = {
			ensureSessionsDir: vi.fn().mockReturnValue(sessionsDir),
			readSessionManifest: vi.fn().mockReturnValue(persisted),
			createRootSessionWithArtifacts: vi.fn(),
			persistSessionMessages: vi.fn(),
			updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
			updateSession,
			writeSessionManifest: vi.fn(),
			listSessions: vi.fn().mockResolvedValue([]),
			deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
		};
		const built = host(
			service,
			async () =>
				result({
					usage: { inputTokens: 1, outputTokens: 1, totalCost: 0.01 },
				}),
			initialMessages,
		);

		await built.manager.startSession(
			startInput(config(sessionId), { interactive: true, initialMessages }),
		);
		expect(
			(await built.manager.getAccumulatedUsage(sessionId))?.aggregateUsage,
		).toEqual(aggregateUsage);

		await built.manager.runTurn({ sessionId, prompt: "again" });
		const metadata = updateSession.mock.calls.at(-1)?.[0].metadata as Record<
			string,
			unknown
		>;
		expect(metadata.aggregatedAgentsCost as number).toBeCloseTo(0.63);
	});
});

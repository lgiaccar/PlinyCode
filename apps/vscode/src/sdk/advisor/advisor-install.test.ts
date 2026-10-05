import type { CoreSessionConfig } from "@plinycode/core"
import type {
	AgentBeforeModelContext,
	AgentBeforeModelResult,
	AgentModel,
	AgentModelEvent,
	AgentToolContext,
	AgentToolDefinition,
} from "@plinycode/shared"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@/shared/pliny"
import { beginTurn, forgetSessionsWithPrefix, getSessionState } from "../router/router-health"
import { type AdvisorInstallDeps, installAdvisor } from "./advisor-install"
import { ADVISOR_TOOL_NAME, type AdvisorSettings, DEFAULT_ADVISOR_SETTINGS } from "./advisor-settings"

const SONNET_5 = DEFAULT_ADVISOR_SETTINGS.model

const KIMI = "snps-provider/kimi-k2.6"
const TOOLS: AgentToolDefinition[] = [
	{ name: "read_files", description: "", inputSchema: {} },
	{ name: ADVISOR_TOOL_NAME, description: "", inputSchema: {} },
]

function advisorModel(): AgentModel {
	return {
		async *stream() {
			yield { type: "text-delta", text: "advice" } satisfies AgentModelEvent
			yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, totalCost: 0.001 } } satisfies AgentModelEvent
			yield { type: "finish", reason: "stop" } satisfies AgentModelEvent
		},
	}
}

function setup(options: { modelId?: string; settings?: Partial<AdvisorSettings>; config?: Partial<CoreSessionConfig> } = {}) {
	let settings: AdvisorSettings = { ...DEFAULT_ADVISOR_SETTINGS, ...options.settings }
	const config = {
		modelId: options.modelId ?? PLINY_BALANCE_AUTO_MODEL_ID,
		knownModels: { [SONNET_5]: { id: SONNET_5, pricing: { input: 3, output: 15 } } },
		...options.config,
	} as unknown as CoreSessionConfig
	const deps: AdvisorInstallDeps = {
		getSettings: () => settings,
		checkBudget: vi.fn(async () => undefined),
		onUsage: vi.fn(),
		routerSessionKey: "advisor-install-test",
		ledger: { callsBySession: new Map(), inFlight: new Set() },
	}
	installAdvisor(config, deps)

	const createDefault = vi.fn((_overrides?: { modelId?: string }) => advisorModel())
	/** What core does at the start of each run. */
	const startRun = (modelId: string, parentAgentId?: string) =>
		config.agentModelFactory?.({
			config: { modelId, knownModels: config.knownModels, ...(parentAgentId ? { parentAgentId } : {}) } as never,
			createDefault,
		})
	/** The tool names the model is shown on its next call. */
	const offeredTools = async (parentAgentId?: string) => {
		const context = {
			snapshot: { parentAgentId },
			request: { messages: [], tools: TOOLS },
		} as unknown as AgentBeforeModelContext
		const result = await config.hooks?.beforeModel?.(context)
		return (result?.tools ?? context.request.tools).map((tool) => tool.name)
	}
	const tool = config.extraTools?.find((candidate) => candidate.name === ADVISOR_TOOL_NAME)
	const toolContext: AgentToolContext = { sessionId: "task-1", agentId: "root", iteration: 1 }
	return {
		config,
		deps,
		createDefault,
		startRun,
		offeredTools,
		ask: () => tool?.execute({ question: "q" }, toolContext),
		setSettings: (next: Partial<AdvisorSettings>) => {
			settings = { ...settings, ...next }
		},
	}
}

afterEach(() => {
	forgetSessionsWithPrefix("advisor-install-test")
})

describe("installAdvisor", () => {
	it("adds the tool to the session's extra tools, after the ones already there", () => {
		const existing = { name: "wait", description: "", inputSchema: {}, execute: async () => "" }
		const { config } = setup({ config: { extraTools: [existing] } })
		expect(config.extraTools?.map((tool) => tool.name)).toEqual(["wait", ADVISOR_TOOL_NAME])
	})

	it("offers the tool on BalanceAuto and hides it on other models by default", async () => {
		expect(await setup({ modelId: PLINY_BALANCE_AUTO_MODEL_ID }).offeredTools()).toEqual(["read_files", ADVISOR_TOOL_NAME])
		expect(await setup({ modelId: PLINY_FREE_AUTO_MODEL_ID }).offeredTools()).toEqual(["read_files"])
		expect(await setup({ modelId: KIMI }).offeredTools()).toEqual(["read_files"])
		expect(await setup({ modelId: "azure-openai/gpt-5.2" }).offeredTools()).toEqual(["read_files"])
	})

	it("offers it on any model but the advisor's own when set to always, and never when turned off", async () => {
		const always = { use: "always" } as const
		expect(await setup({ modelId: PLINY_FREE_AUTO_MODEL_ID, settings: always }).offeredTools()).toContain(ADVISOR_TOOL_NAME)
		expect(await setup({ modelId: KIMI, settings: always }).offeredTools()).toContain(ADVISOR_TOOL_NAME)
		expect(await setup({ modelId: SONNET_5, settings: always }).offeredTools()).toEqual(["read_files"])
		expect(await setup({ settings: { use: "never" } }).offeredTools()).toEqual(["read_files"])
	})

	it("follows a setting change and a model switch in a running session", async () => {
		const session = setup({ modelId: PLINY_FREE_AUTO_MODEL_ID })
		session.startRun(PLINY_FREE_AUTO_MODEL_ID)
		expect(await session.offeredTools()).toEqual(["read_files"])

		session.setSettings({ use: "always" })
		expect(await session.offeredTools()).toContain(ADVISOR_TOOL_NAME)

		session.setSettings({ use: "balance" })
		expect(await session.offeredTools()).toEqual(["read_files"])
		// The next run starts on BalanceAuto: the session config is not rebuilt for a model switch.
		session.startRun(PLINY_BALANCE_AUTO_MODEL_ID)
		expect(await session.offeredTools()).toContain(ADVISOR_TOOL_NAME)
	})

	it("never offers it to a sub-agent", async () => {
		const session = setup({ settings: { use: "always" } })
		expect(await session.offeredTools("root-agent")).toEqual(["read_files"])
		// A sub-agent run does not change which model the conversation is on.
		session.startRun(KIMI, "root-agent")
		expect(await session.offeredTools()).toContain(ADVISOR_TOOL_NAME)
	})

	it("keeps the hooks and the model factory that were already installed", async () => {
		const routed = advisorModel()
		const baseFactory = vi.fn(() => routed)
		const baseBeforeModel = vi.fn(
			async (): Promise<AgentBeforeModelResult> => ({ options: { thinking: true }, tools: TOOLS.slice(0, 2) }),
		)
		const session = setup({
			modelId: PLINY_FREE_AUTO_MODEL_ID,
			config: { agentModelFactory: baseFactory, hooks: { beforeModel: baseBeforeModel } },
		})
		expect(session.startRun(PLINY_FREE_AUTO_MODEL_ID)).toBe(routed)
		expect(baseFactory).toHaveBeenCalledTimes(1)

		const context = { snapshot: {}, request: { messages: [], tools: TOOLS } } as unknown as AgentBeforeModelContext
		const hidden = await session.config.hooks?.beforeModel?.(context)
		expect(hidden).toEqual({ options: { thinking: true }, tools: [TOOLS[0]] })

		// A stop from an earlier hook passes through untouched.
		const stop = { stop: true, reason: "spending_limit_reached" }
		baseBeforeModel.mockResolvedValueOnce(stop)
		expect(await session.config.hooks?.beforeModel?.(context)).toBe(stop)
	})

	it("builds the advisor model on the session's connection, once a run has started", async () => {
		const session = setup()
		await expect(session.ask()).rejects.toThrow("not ready yet")

		session.startRun(PLINY_BALANCE_AUTO_MODEL_ID)
		await expect(session.ask()).resolves.toMatchObject({ advice: "advice", model: SONNET_5 })
		expect(session.createDefault).toHaveBeenCalledWith({ modelId: SONNET_5 })
		expect(session.deps.checkBudget).toHaveBeenCalledWith("task-1")
		expect(session.deps.onUsage).toHaveBeenCalledWith("task-1", expect.objectContaining({ totalCost: 0.001 }))
	})

	it("refuses a call when the router's last call already ran on the advisor model", async () => {
		const session = setup()
		session.startRun(PLINY_BALANCE_AUTO_MODEL_ID)
		beginTurn("advisor-install-test", 0)
		getSessionState("advisor-install-test").calls.push({
			modelId: SONNET_5,
			startedAt: 0,
			routeName: "default",
			estimatedTokens: 0,
		})
		await expect(session.ask()).rejects.toThrow("already running on the advisor model")

		// A free model answering the turn may ask.
		getSessionState("advisor-install-test").calls.push({
			modelId: KIMI,
			startedAt: 1,
			routeName: "coding",
			estimatedTokens: 0,
		})
		await expect(session.ask()).resolves.toMatchObject({ advice: "advice" })
	})
})

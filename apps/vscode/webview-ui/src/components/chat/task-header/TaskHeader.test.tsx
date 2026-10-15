import type { ClineMessage } from "@shared/ExtensionMessage"
import { EditMessageAndRegenerateRequest } from "@shared/proto/cline/task"
import { fireEvent, render, screen } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { autoCompactThresholdFor } from "./autoCompactThreshold"
import TaskHeader from "./TaskHeader"

describe("autoCompactThresholdFor", () => {
	it("is 90% of the model's input limit, as a share of its context window", () => {
		// FreeAuto: a 256k window with a 92k input budget.
		expect(autoCompactThresholdFor({ contextWindow: 256_000, maxInputTokens: 92_000 })).toBeCloseTo(0.3234, 3)
		// A catalog model whose limit is its window.
		expect(autoCompactThresholdFor({ contextWindow: 200_000, maxInputTokens: 200_000 })).toBeCloseTo(0.9, 3)
		// Only a window known: the engine assumes 90% of it is usable input.
		expect(autoCompactThresholdFor({ contextWindow: 128_000 })).toBeCloseTo(0.81, 3)
		expect(autoCompactThresholdFor(undefined)).toBeUndefined()
		expect(autoCompactThresholdFor({ contextWindow: 0 })).toBeUndefined()
	})
})

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedModelInfo: { contextWindow: 200_000, supportsPromptCache: true },
	}),
}))

vi.mock("@/hooks/useProviderUsageCostDisplay", () => ({
	useProviderUsageCostDisplay: () => "show",
}))

const mocks = vi.hoisted(() => ({
	expandTaskHeader: true,
	editMessageAndRegenerate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		editMessageAndRegenerate: mocks.editMessageAndRegenerate,
	},
	ModelsServiceClient: {
		getPlinyBudget: vi.fn(() => new Promise(() => undefined)),
		resolveModelInfo: vi.fn(() => new Promise(() => undefined)),
	},
	CheckpointsServiceClient: {
		checkpointLatestChangesSummary: vi.fn(),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-test" },
		currentTaskItem: { id: "task-1", cwdOnTaskInitialization: "/workspace" },
		mode: "act",
		expandTaskHeader: mocks.expandTaskHeader,
		setExpandTaskHeader: vi.fn(),
		environment: "production",
		workspaceRoots: [{ path: "/workspace", name: "workspace" }],
		platform: "linux",
	}),
}))

function makeTask(text: string, ts = 1_700_000_000_000): ClineMessage {
	return { ts, type: "say", say: "task", text, partial: false }
}

describe("TaskHeader", () => {
	beforeEach(() => {
		mocks.expandTaskHeader = true
		mocks.editMessageAndRegenerate.mockClear()
	})

	it("shows edit controls for the opening prompt when expanded", () => {
		const task = makeTask("Build the feature")
		render(
			<TaskHeader
				cacheReads={0}
				cacheWrites={0}
				clineMessages={[task]}
				contextBreakdown={undefined}
				doesModelSupportPromptCache={true}
				lastApiReqTotalTokens={0}
				onClose={vi.fn()}
				task={task}
				tokensIn={0}
				tokensOut={0}
				totalCost={0}
			/>,
		)

		expect(screen.getByLabelText("Edit and restart from this message")).toBeDefined()
	})

	it("calls editMessageAndRegenerate with the task timestamp when saving", async () => {
		const task = makeTask("Build the feature")
		render(
			<TaskHeader
				cacheReads={0}
				cacheWrites={0}
				clineMessages={[task]}
				contextBreakdown={undefined}
				doesModelSupportPromptCache={true}
				lastApiReqTotalTokens={0}
				onClose={vi.fn()}
				task={task}
				tokensIn={0}
				tokensOut={0}
				totalCost={0}
			/>,
		)

		fireEvent.click(screen.getByLabelText("Edit and restart from this message"))
		const textarea = screen.getByRole("textbox")
		fireEvent.change(textarea, { target: { value: "Build a better feature" } })
		fireEvent.click(screen.getByRole("button", { name: "Restart from here" }))

		await vi.waitFor(() => {
			expect(mocks.editMessageAndRegenerate).toHaveBeenCalledWith(
				EditMessageAndRegenerateRequest.create({
					messageTs: task.ts,
					text: "Build a better feature",
					images: [],
					files: [],
					restoreWorkspace: false,
				}),
			)
		})
	})
})

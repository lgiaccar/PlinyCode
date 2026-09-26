import type { TaskItem } from "@shared/proto/cline/task"
import { fireEvent, render, screen } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import HistoryViewItem from "./HistoryViewItem"

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onClick }: any) => <input checked={checked} onClick={onClick} readOnly type="checkbox" />,
}))

vi.mock("@/hooks/useUsageCostVisibility", () => ({
	useUsageCostVisibility: () => () => true,
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		showTaskWithId: vi.fn().mockResolvedValue(undefined),
		exportTaskWithId: vi.fn().mockResolvedValue(undefined),
		exportTaskToMarkdown: vi.fn().mockResolvedValue(undefined),
	},
}))

const mocks = vi.hoisted(() => ({
	platform: "linux" as string,
	backgroundTasks: [] as { id: string; status: "running" | "needs_attention" }[],
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ platform: mocks.platform, backgroundTasks: mocks.backgroundTasks }),
}))

function makeItem(overrides: Partial<TaskItem> = {}): TaskItem {
	return {
		id: "task-1",
		task: "Fix the build",
		ts: Date.now(),
		isFavorited: false,
		size: 0,
		totalCost: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheWrites: 0,
		cacheReads: 0,
		modelId: "claude-test",
		isLegacy: false,
		apiProvider: "anthropic",
		workspaceRoot: "",
		startedTs: 0,
		activeMs: 0,
		...overrides,
	}
}

const noop = () => {}

describe("HistoryViewItem", () => {
	beforeEach(() => {
		mocks.platform = "linux"
		mocks.backgroundTasks = []
	})

	function renderItem() {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem()}
				pendingFavoriteToggles={{}}
				renameTask={noop}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)
	}

	it("shows no badge for a task that is not running in the background", () => {
		renderItem()
		expect(screen.queryByTestId("background-task-badge")).toBeNull()
	})

	it("badges a task running in the background", () => {
		mocks.backgroundTasks = [{ id: "task-1", status: "running" }]
		renderItem()
		expect(screen.getByTestId("background-task-badge").textContent).toBe("Running")
	})

	it("badges a background task that waits for the user", () => {
		mocks.backgroundTasks = [{ id: "task-1", status: "needs_attention" }]
		renderItem()
		expect(screen.getByTestId("background-task-badge").textContent).toBe("Needs approval")
	})

	it("shows the parent-qualified workspace label and a full-path tooltip", () => {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem({ workspaceRoot: "/home/user/my-project" })}
				pendingFavoriteToggles={{}}
				renameTask={noop}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getByText("user/my-project")).toBeDefined()
		expect(screen.getByText("/home/user/my-project")).toBeDefined()
	})

	it("splits the parent-qualified label on backslashes for Windows paths", () => {
		mocks.platform = "win32"
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem({ workspaceRoot: "C:\\Users\\dev\\my-project" })}
				pendingFavoriteToggles={{}}
				renameTask={noop}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getByText("dev/my-project")).toBeDefined()
	})

	it("shows an 'Unknown workspace' fallback for legacy items with no stored root", () => {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem({ workspaceRoot: "", isLegacy: true })}
				pendingFavoriteToggles={{}}
				renameTask={noop}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getAllByText("Unknown workspace").length).toBeGreaterThan(0)
	})

	it("shows the markdown export control without requiring row hover", () => {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem()}
				pendingFavoriteToggles={{}}
				renameTask={noop}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getByRole("button", { name: "Export conversation as Markdown" })).toBeDefined()
	})

	it("renames the conversation inline and saves on Enter", () => {
		const renameTask = vi.fn()
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem()}
				pendingFavoriteToggles={{}}
				renameTask={renameTask}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }))
		const input = screen.getByRole("textbox", { name: "Conversation name" })
		fireEvent.change(input, { target: { value: "  Build fix  " } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(renameTask).toHaveBeenCalledWith("task-1", "Build fix")
		expect(screen.queryByRole("textbox", { name: "Conversation name" })).toBeNull()
	})

	it("discards the rename on Escape", () => {
		const renameTask = vi.fn()
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem()}
				pendingFavoriteToggles={{}}
				renameTask={renameTask}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }))
		const input = screen.getByRole("textbox", { name: "Conversation name" })
		fireEvent.change(input, { target: { value: "Other" } })
		fireEvent.keyDown(input, { key: "Escape" })

		expect(renameTask).not.toHaveBeenCalled()
	})

	it("shows the start time and the agent running time", () => {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem({ startedTs: Date.now() - 3_600_000, activeMs: 125_000 })}
				pendingFavoriteToggles={{}}
				renameTask={noop}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getByText(/^Started /)).toBeDefined()
		expect(screen.getByText("· ran 2m 5s")).toBeDefined()
	})
})

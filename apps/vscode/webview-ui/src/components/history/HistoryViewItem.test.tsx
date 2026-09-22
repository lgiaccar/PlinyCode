import type { TaskItem } from "@shared/proto/cline/task"
import { render, screen } from "@testing-library/react"
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
	},
}))

const mocks = vi.hoisted(() => ({
	platform: "linux" as string,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ platform: mocks.platform }),
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
		...overrides,
	}
}

const noop = () => {}

describe("HistoryViewItem", () => {
	beforeEach(() => {
		mocks.platform = "linux"
	})

	it("shows the workspace basename and a full-path tooltip", () => {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem({ workspaceRoot: "/home/user/my-project" })}
				pendingFavoriteToggles={{}}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getByText("my-project")).toBeDefined()
		expect(screen.getByText("/home/user/my-project")).toBeDefined()
	})

	it("splits the basename on backslashes for Windows paths", () => {
		mocks.platform = "win32"
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem({ workspaceRoot: "C:\\Users\\dev\\my-project" })}
				pendingFavoriteToggles={{}}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getByText("my-project")).toBeDefined()
	})

	it("shows an 'Unknown workspace' fallback for legacy items with no stored root", () => {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={noop}
				handleHistorySelect={noop}
				index={0}
				item={makeItem({ workspaceRoot: "", isLegacy: true })}
				pendingFavoriteToggles={{}}
				selectedItems={[]}
				toggleFavorite={noop}
			/>,
		)

		expect(screen.getAllByText("Unknown workspace").length).toBeGreaterThan(0)
	})
})

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { NewTaskWorkspacePicker } from "./NewTaskWorkspacePicker"
import { WorkspaceSelect, type WorkspaceSelection } from "./WorkspaceSelect"

const mocks = vi.hoisted(() => ({
	listRecentWorkspaces: vi.fn(),
	pickWorkspace: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	WorkspaceServiceClient: {
		listRecentWorkspaces: mocks.listRecentWorkspaces,
		pickWorkspace: mocks.pickWorkspace,
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ platform: "linux" }),
}))

// Radix Select renders through portals with pointer-capture APIs jsdom lacks;
// a plain <select> keeps the tests about what this component decides.
vi.mock("@/components/ui/select", () => ({
	Select: ({ value, onValueChange, children }: any) => (
		<select aria-label="select" onChange={(event) => onValueChange(event.target.value)} value={value}>
			{children}
		</select>
	),
	SelectTrigger: ({ children, title }: any) => (
		<div data-testid="trigger" title={title}>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ value, children }: any) => <option value={value}>{extractText(children)}</option>,
	SelectSeparator: () => null,
}))

function extractText(node: any): string {
	if (node == null || typeof node === "boolean") {
		return ""
	}
	if (typeof node === "string" || typeof node === "number") {
		return String(node)
	}
	if (Array.isArray(node)) {
		return node.map(extractText).join("")
	}
	return extractText(node.props?.children)
}

const current = { path: "/home/dev/PlinyCode", kind: "folder", folders: ["/home/dev/PlinyCode"], lastUsedTs: 3 }
const recent = [
	current,
	{ path: "/home/dev/other", kind: "folder", folders: ["/home/dev/other"], lastUsedTs: 2 },
	{ path: "/home/dev/all.code-workspace", kind: "workspaceFile", folders: ["/a", "/b"], lastUsedTs: 1 },
]

describe("NewTaskWorkspacePicker", () => {
	it("defaults to the window's workspace and lists the other recent ones plus the pickers", async () => {
		mocks.listRecentWorkspaces.mockResolvedValue({ current, recent })
		render(<NewTaskWorkspacePicker onChange={vi.fn()} value={undefined} />)

		await waitFor(() => expect(screen.getByTestId("trigger").textContent).toContain("dev/PlinyCode"))
		const options = Array.from(screen.getByLabelText("select").querySelectorAll("option")).map((option) => option.textContent)
		expect(options).toEqual([
			"dev/PlinyCode(this window)",
			"dev/other",
			"all",
			"Choose folder…",
			"Choose .code-workspace file…",
		])
	})

	it("reports a recent workspace as the choice and the window's as undefined", async () => {
		mocks.listRecentWorkspaces.mockResolvedValue({ current, recent })
		const onChange = vi.fn()
		render(<NewTaskWorkspacePicker onChange={onChange} value={undefined} />)
		await waitFor(() => expect(screen.getByLabelText("select").querySelectorAll("option").length).toBe(5))

		fireEvent.change(screen.getByLabelText("select"), { target: { value: "/home/dev/all.code-workspace" } })
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ path: "/home/dev/all.code-workspace", kind: "workspaceFile" }),
		)

		fireEvent.change(screen.getByLabelText("select"), { target: { value: "__current__" } })
		expect(onChange).toHaveBeenLastCalledWith(undefined)
	})

	it("opens the native picker and adopts what it returns, ignoring a cancel", async () => {
		mocks.listRecentWorkspaces.mockResolvedValue({ current, recent })
		mocks.pickWorkspace.mockResolvedValueOnce({ path: "", kind: "", folders: [], lastUsedTs: 0 })
		mocks.pickWorkspace.mockResolvedValueOnce({ path: "/picked", kind: "folder", folders: ["/picked"], lastUsedTs: 9 })
		const onChange = vi.fn()
		render(<NewTaskWorkspacePicker onChange={onChange} value={undefined} />)
		await waitFor(() => expect(screen.getByLabelText("select").querySelectorAll("option").length).toBe(5))

		fireEvent.change(screen.getByLabelText("select"), { target: { value: "__pick_folder__" } })
		await waitFor(() => expect(mocks.pickWorkspace).toHaveBeenCalledWith(expect.objectContaining({ kind: "folder" })))
		expect(onChange).not.toHaveBeenCalled()

		fireEvent.change(screen.getByLabelText("select"), { target: { value: "__pick_file__" } })
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ path: "/picked" })))
		expect(mocks.pickWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "workspaceFile" }))
	})
})

describe("WorkspaceSelect", () => {
	it("offers 'All workspaces' for history filtering and labels the selection", () => {
		const workspaces = { current, recent: recent.slice(1), loaded: true, reload: vi.fn(), pick: vi.fn() } as any
		const onChange = vi.fn()
		const value: WorkspaceSelection = { kind: "all" }
		render(<WorkspaceSelect allowAll onChange={onChange} value={value} workspaces={workspaces} />)

		expect(screen.getByTestId("trigger").textContent).toBe("All workspaces")
		const options = Array.from(screen.getByLabelText("select").querySelectorAll("option")).map((option) => option.textContent)
		expect(options).toEqual(["dev/PlinyCode(this window)", "All workspaces", "dev/other", "all"])

		fireEvent.change(screen.getByLabelText("select"), { target: { value: "/home/dev/other" } })
		expect(onChange).toHaveBeenCalledWith({
			kind: "workspace",
			workspace: expect.objectContaining({ path: "/home/dev/other" }),
		})
	})

	it("shows a picked workspace that is not in the recent list yet", () => {
		const workspaces = { current, recent: [], loaded: true, reload: vi.fn(), pick: vi.fn() } as any
		const picked = { path: "/elsewhere/proj", kind: "folder" as const, folders: ["/elsewhere/proj"] }
		render(<WorkspaceSelect onChange={vi.fn()} value={{ kind: "workspace", workspace: picked }} workspaces={workspaces} />)

		expect(screen.getByTestId("trigger").textContent).toBe("elsewhere/proj")
		expect(screen.getByLabelText("select")).toHaveValue("/elsewhere/proj")
	})
})

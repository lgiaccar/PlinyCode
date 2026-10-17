import type { AgentInfo } from "@shared/proto/cline/file"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AgentsTab from "./AgentsTab"

const mocks = vi.hoisted(() => ({
	toggleAgent: vi.fn(),
	createAgentFile: vi.fn(),
	openFile: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		toggleAgent: mocks.toggleAgent,
		createAgentFile: mocks.createAgentFile,
		openFile: mocks.openFile,
	},
}))

const agent = (overrides: Partial<AgentInfo>): AgentInfo => ({
	name: "reviewer",
	description: "Reviews diffs",
	path: "/repo/.cline/agents/reviewer.md",
	enabled: true,
	model: "",
	toolName: "subagent_reviewer",
	error: "",
	...overrides,
})

const refreshed = { globalAgents: [], localAgents: [agent({ enabled: false })] }

describe("AgentsTab", () => {
	beforeEach(() => {
		mocks.toggleAgent.mockReset().mockResolvedValue(refreshed)
		mocks.createAgentFile.mockReset().mockResolvedValue(refreshed)
		mocks.openFile.mockReset().mockResolvedValue({})
	})

	it("lists each agent with its tool, description, model and path", () => {
		render(
			<AgentsTab
				globalAgents={[
					agent({
						name: "planner",
						description: "Plans work",
						path: "/home/.cline/agents/planner.md",
						model: "pliny/some-model",
						toolName: "subagent_planner",
					}),
				]}
				localAgents={[agent({})]}
				onAgentsChanged={() => {}}
			/>,
		)
		expect(screen.getAllByTestId("agent-row")).toHaveLength(2)
		expect(screen.getByText("subagent_reviewer")).toBeTruthy()
		expect(screen.getByText("Reviews diffs")).toBeTruthy()
		expect(screen.getByText(/Model: pliny\/some-model/)).toBeTruthy()
		expect(screen.getByText("/repo/.cline/agents/reviewer.md")).toBeTruthy()
		expect(screen.getByText(/2 of 2 agents offered/)).toBeTruthy()
	})

	it("switches an agent off through the RPC and hands back the new list", async () => {
		const onAgentsChanged = vi.fn()
		render(<AgentsTab globalAgents={[]} localAgents={[agent({})]} onAgentsChanged={onAgentsChanged} />)

		fireEvent.click(screen.getByRole("switch", { name: "Disable agent reviewer" }))
		expect(mocks.toggleAgent).toHaveBeenCalledWith(
			expect.objectContaining({ agentPath: "/repo/.cline/agents/reviewer.md", isGlobal: false, enabled: false }),
		)
		await waitFor(() => expect(onAgentsChanged).toHaveBeenCalledWith(refreshed))
	})

	it("opens the agent's file", () => {
		render(<AgentsTab globalAgents={[]} localAgents={[agent({})]} onAgentsChanged={() => {}} />)
		fireEvent.click(screen.getByRole("button", { name: "Open reviewer" }))
		expect(mocks.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: "/repo/.cline/agents/reviewer.md" }))
	})

	it("shows a file that did not load, without a usable switch", () => {
		render(
			<AgentsTab
				globalAgents={[]}
				localAgents={[agent({ name: "broken", toolName: "", error: "Missing YAML frontmatter block" })]}
				onAgentsChanged={() => {}}
			/>,
		)
		expect(screen.getByText(/Not loaded: Missing YAML frontmatter block/)).toBeTruthy()
		expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true)
	})

	it("creates a workspace agent from the New agent row", async () => {
		const onAgentsChanged = vi.fn()
		render(<AgentsTab globalAgents={[]} localAgents={[]} onAgentsChanged={onAgentsChanged} />)

		fireEvent.change(screen.getByLabelText("New workspace agent name"), { target: { value: "test-writer" } })
		fireEvent.click(screen.getAllByRole("button", { name: "New agent" })[1])
		await waitFor(() =>
			expect(mocks.createAgentFile).toHaveBeenCalledWith(
				expect.objectContaining({ agentName: "test-writer", isGlobal: false }),
			),
		)
		await waitFor(() => expect(onAgentsChanged).toHaveBeenCalledWith(refreshed))
	})

	it("rejects a name that cannot be a file name", () => {
		render(<AgentsTab globalAgents={[]} localAgents={[]} onAgentsChanged={() => {}} />)
		fireEvent.change(screen.getByLabelText("New global agent name"), { target: { value: "bad name!" } })
		fireEvent.click(screen.getAllByRole("button", { name: "New agent" })[0])
		expect(mocks.createAgentFile).not.toHaveBeenCalled()
		expect(screen.getByText(/can only contain letters/)).toBeTruthy()
	})
})

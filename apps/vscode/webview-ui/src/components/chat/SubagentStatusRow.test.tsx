import type { ClineMessage, ClineSaySubagentStatus, SubagentStatusItem } from "@shared/ExtensionMessage"
import { SubagentMessagesUpdate } from "@shared/proto/cline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SubagentStatusRow from "./SubagentStatusRow"
import type { SubagentTranscriptRowProps } from "./SubagentTranscript"

vi.mock("@/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

type Callbacks = { onResponse: (update: SubagentMessagesUpdate) => void }
const grpc = vi.hoisted(() => ({
	subscribe: vi.fn(),
	unsubscribe: vi.fn(),
	callbacks: [] as Array<{ onResponse: (update: unknown) => void }>,
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		subscribeToSubagentMessages: (request: unknown, callbacks: Callbacks) => {
			grpc.subscribe(request)
			grpc.callbacks.push(callbacks as { onResponse: (update: unknown) => void })
			return grpc.unsubscribe
		},
	},
}))

function item(overrides: Partial<SubagentStatusItem>): SubagentStatusItem {
	return {
		index: 1,
		prompt: "Explore the repo",
		status: "running",
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
		...overrides,
	}
}

function statusMessage(items: SubagentStatusItem[]): ClineMessage {
	const status: ClineSaySubagentStatus = {
		status: "running",
		total: items.length,
		completed: 0,
		successes: 0,
		failures: 0,
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		contextWindow: 0,
		maxContextTokens: 0,
		maxContextUsagePercentage: 0,
		items,
	}
	return { ts: 1, type: "say", say: "subagent", text: JSON.stringify(status), partial: true }
}

/** Stand-in for ChatRow: just the row's text. */
const FakeRow = ({ message }: SubagentTranscriptRowProps) => <div data-testid="transcript-row">{message.text}</div>

const textRow = (ts: number, text: string, partial = false): ClineMessage => ({ ts, type: "say", say: "text", text, partial })

function push(reset: boolean, messages: ClineMessage[]) {
	act(() => {
		grpc.callbacks
			.at(-1)
			?.onResponse(SubagentMessagesUpdate.create({ reset, messages: messages.map(convertClineMessageToProto) }))
	})
}

describe("SubagentStatusRow transcripts", () => {
	beforeEach(() => {
		grpc.subscribe.mockClear()
		grpc.unsubscribe.mockClear()
		grpc.callbacks = []
	})

	it("subscribes when an item is expanded, renders its rows, and unsubscribes when collapsed", () => {
		render(
			<SubagentStatusRow
				isLast
				message={statusMessage([
					item({ index: 1, agentId: "sub-1" }),
					item({ index: 2, prompt: "Other", agentId: "sub-2" }),
				])}
				TranscriptRow={FakeRow}
			/>,
		)
		expect(grpc.subscribe).not.toHaveBeenCalled()

		const [firstToggle] = screen.getAllByRole("button", { name: "Show sub-agent transcript" })
		fireEvent.click(firstToggle)
		expect(grpc.subscribe).toHaveBeenCalledTimes(1)
		expect(grpc.subscribe.mock.calls[0][0]).toMatchObject({ agentId: "sub-1" })
		expect(screen.getByTestId("subagent-transcript-empty")).toBeTruthy()

		push(true, [textRow(10, "Looking around")])
		push(false, [textRow(11, "Reading files", true)])
		// A later update to the same ts replaces the row in place.
		push(false, [textRow(11, "Read three files")])
		expect(screen.getAllByTestId("transcript-row").map((row) => row.textContent)).toEqual([
			"Looking around",
			"Read three files",
		])

		fireEvent.click(screen.getByRole("button", { name: "Hide sub-agent transcript" }))
		expect(grpc.unsubscribe).toHaveBeenCalledTimes(1)
		expect(screen.queryByTestId("transcript-row")).toBeNull()
	})

	it("has no toggle before the sub-agent is named, or without a row component", () => {
		const { rerender } = render(
			<SubagentStatusRow isLast message={statusMessage([item({ index: 1 })])} TranscriptRow={FakeRow} />,
		)
		expect(screen.queryByRole("button", { name: "Show sub-agent transcript" })).toBeNull()

		rerender(<SubagentStatusRow isLast message={statusMessage([item({ index: 1, agentId: "sub-1" })])} />)
		expect(screen.queryByRole("button", { name: "Show sub-agent transcript" })).toBeNull()
	})

	it("says the transcript is gone for a finished sub-agent whose transcript was not kept", () => {
		render(
			<SubagentStatusRow
				isLast
				message={statusMessage([item({ index: 1, agentId: "sub-1", status: "completed", result: "Done." })])}
				TranscriptRow={FakeRow}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Show sub-agent transcript" }))
		push(true, [])
		expect(screen.getByTestId("subagent-transcript-empty").textContent).toContain("kept only while")
	})
})

import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import CompactionRow from "./CompactionRow"

function row(info: Record<string, unknown>): ClineMessage {
	return { ts: 1, type: "say", say: "compaction", text: JSON.stringify(info) }
}

describe("CompactionRow", () => {
	it("opens the summary the model continues from", () => {
		render(
			<CompactionRow
				message={row({
					status: "completed",
					mode: "auto",
					tokensBefore: 182_000,
					tokensAfter: 61_000,
					summary: "## Progress\nDone",
				})}
			/>,
		)
		expect(screen.getByText(/Context compacted · 182k → 61k tokens/)).toBeTruthy()
		expect(screen.queryByText(/## Progress/)).toBeNull()
		fireEvent.click(screen.getByText("Show summary"))
		expect(screen.getByText(/## Progress/)).toBeTruthy()
	})

	it("names a compaction forced by a rejected request, and offers no summary without one", () => {
		render(<CompactionRow message={row({ status: "completed", mode: "overflow" })} />)
		expect(screen.getByText("Context compacted (the model rejected it as too large)")).toBeTruthy()
		expect(screen.queryByText("Show summary")).toBeNull()
	})
})

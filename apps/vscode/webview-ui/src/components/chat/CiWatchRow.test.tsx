import { isCiWatchReport } from "@shared/ciWatch"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CiWatchRow } from "./CiWatchRow"

vi.mock("./MarkdownRow", () => ({
	MarkdownRow: ({ markdown }: { markdown: string }) => <div data-testid="body">{markdown}</div>,
}))

describe("CiWatchRow", () => {
	const report = "[CI WATCHER] CI failed for PR #7 (feature → main) at aaaaaaaa: 1 failed.\n\nRuns:\n- failure: unit"

	it("recognises the watcher's reports among user messages", () => {
		expect(isCiWatchReport(report)).toBe(true)
		expect(isCiWatchReport("why did [CI WATCHER] say that?")).toBe(false)
		expect(isCiWatchReport(undefined)).toBe(false)
	})

	it("shows a report under the watcher's name, without the marker", () => {
		render(<CiWatchRow text={report} />)
		expect(screen.getByText("CI watcher")).toBeTruthy()
		const body = screen.getByTestId("body").textContent ?? ""
		expect(body.startsWith("CI failed for PR #7 (feature → main) at aaaaaaaa: 1 failed.")).toBe(true)
		expect(body).not.toContain("[CI WATCHER]")
	})
})

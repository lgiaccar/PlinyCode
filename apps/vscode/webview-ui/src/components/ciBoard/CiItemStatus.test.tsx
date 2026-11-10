import { CiItem } from "@shared/proto/cline/ci_board"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CiItemStatus } from "./CiItemStatus"

describe("CI freshness", () => {
	it("shows the last successful check and head even after a refresh error", () => {
		const checkedTs = Date.UTC(2026, 10, 10, 12)
		const item = CiItem.create({ checkedTs, headSha: "abcdef123456", error: "Unavailable" })
		const { rerender } = render(<CiItemStatus item={item} now={checkedTs + 120_000} />)
		expect(screen.getByText("CI checked 2 min ago")).toHaveAttribute("datetime", new Date(checkedTs).toISOString())
		expect(screen.getByText("abcdef12")).toBeInTheDocument()
		expect(screen.getByText(/Refresh failed/)).toBeInTheDocument()
		rerender(<CiItemStatus item={item} now={checkedTs + 180_000} />)
		expect(screen.getByText("CI checked 3 min ago")).toBeInTheDocument()
	})
	it("does not invent a check time when the backend has no successful snapshot", () => {
		render(<CiItemStatus item={CiItem.create()} now={Date.now()} />)
		expect(screen.getByText("CI check time unavailable")).toBeInTheDocument()
	})
})

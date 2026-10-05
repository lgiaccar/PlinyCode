import { fireEvent, render, screen } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { ModeSwitch, modeColor, nextMode } from "./ModeSwitch"

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children, hidden }: PropsWithChildren<{ hidden?: boolean }>) => (hidden ? null : <div>{children}</div>),
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

describe("ModeSwitch", () => {
	it("offers Plan, Agent and Ask and marks the current mode", () => {
		render(<ModeSwitch mode="ask" onModeSelect={vi.fn()} togglePlanActKeys="Ctrl+Shift+A" />)

		expect(screen.getAllByRole("switch").map((segment) => segment.textContent)).toEqual(["Plan", "Agent", "Ask"])
		expect(screen.getByRole("switch", { name: "Ask" }).getAttribute("aria-checked")).toBe("true")
		expect(screen.getByRole("switch", { name: "Agent" }).getAttribute("aria-checked")).toBe("false")
		expect(screen.getByRole("switch", { name: "Plan" }).getAttribute("aria-checked")).toBe("false")
	})

	it("selects the mode of the segment that was clicked", () => {
		const onModeSelect = vi.fn()
		render(<ModeSwitch mode="act" onModeSelect={onModeSelect} togglePlanActKeys="Ctrl+Shift+A" />)

		fireEvent.click(screen.getByRole("switch", { name: "Ask" }))
		fireEvent.click(screen.getByRole("switch", { name: "Plan" }))

		expect(onModeSelect.mock.calls).toEqual([["ask"], ["plan"]])
	})

	it("explains the hovered mode", () => {
		render(<ModeSwitch mode="act" onModeSelect={vi.fn()} togglePlanActKeys="Ctrl+Shift+A" />)

		fireEvent.mouseOver(screen.getByRole("switch", { name: "Ask" }))

		expect(screen.getByText(/In Ask mode, PlinyCode will answer your questions without editing any file/)).toBeTruthy()
	})

	it("cycles Plan, Agent, Ask with the shortcut", () => {
		expect(nextMode("plan")).toBe("act")
		expect(nextMode("act")).toBe("ask")
		expect(nextMode("ask")).toBe("plan")
	})
})

describe("modeColor", () => {
	it("gives each mode its own color: Plan yellow, Agent red, Ask green", () => {
		expect(modeColor("plan")).toBe("var(--vscode-activityWarningBadge-background)")
		expect(modeColor("act")).toBe("var(--vscode-statusBarItem-errorBackground, #c72e0f)")
		expect(modeColor("ask")).toBe("#16825d")
	})
})

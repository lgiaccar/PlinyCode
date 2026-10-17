import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes, PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ContextWindow from "./ContextWindow"

const condense = vi.fn().mockResolvedValue(undefined)

vi.mock("@/services/grpc-client", () => ({
	SlashServiceClient: {
		condense: (request: unknown) => condense(request),
	},
}))

vi.mock("@shared/proto/cline/common", () => ({
	StringRequest: {
		create: (request: unknown) => request,
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

vi.mock("@/components/ui/hover-card", () => ({
	HoverCard: ({ children }: PropsWithChildren) => <div>{children}</div>,
	HoverCardContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	HoverCardTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))

vi.mock("@/components/ui/progress", () => ({
	Progress: ({ value }: { value?: number }) => (
		<div aria-label="Context window usage progress" role="progressbar">
			{value}
		</div>
	),
}))

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock("@/components/ui/button", () => ({
	Button: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

describe("ContextWindow auto condense marker", () => {
	it("draws the marker where auto condense runs and names the token count", () => {
		render(
			<ContextWindow
				autoCompactThreshold={0.32}
				contextWindow={256_000}
				lastApiReqTotalTokens={40_000}
				useAutoCondense={false}
			/>,
		)
		const marker = screen.getByTestId("auto-compact-threshold")
		expect(Number.parseFloat(marker.style.left)).toBeCloseTo(32, 5)
		expect(marker.title).toContain("81.9k tokens")
	})

	it("draws no marker without a threshold", () => {
		render(<ContextWindow contextWindow={200_000} lastApiReqTotalTokens={40_000} useAutoCondense={false} />)
		expect(screen.queryByTestId("auto-compact-threshold")).not.toBeInTheDocument()
	})
})

describe("ContextWindow click-to-set threshold", () => {
	// A 200k window with a 100k input limit: the default 90% threshold sits at 45% of the bar.
	const props = {
		autoCompactThreshold: 0.45,
		compactionThreshold: 0.9,
		contextWindow: 200_000,
		lastApiReqTotalTokens: 40_000,
		maxInputTokens: 100_000,
	}

	const mockBarWidth = (bar: HTMLElement) => {
		bar.getBoundingClientRect = () =>
			({ left: 0, width: 200, top: 0, height: 4, right: 200, bottom: 4, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
	}

	it("sets the threshold where the bar is clicked and moves the marker there", () => {
		const onChange = vi.fn()
		render(<ContextWindow {...props} onCompactionThresholdChange={onChange} useAutoCondense={true} />)
		const bar = screen.getByRole("slider", { name: "Auto condense threshold" })
		mockBarWidth(bar)

		// 30% of the window is 60k tokens: 60% of the 100k input limit.
		fireEvent.click(bar, { clientX: 60 })

		expect(onChange).toHaveBeenCalledWith(0.6)
		expect(Number.parseFloat(screen.getByTestId("auto-compact-threshold").style.left)).toBeCloseTo(30, 5)
		expect(bar).toHaveAttribute("aria-valuenow", "60")
	})

	it("clamps a click past the input limit to the highest threshold", () => {
		const onChange = vi.fn()
		render(<ContextWindow {...props} onCompactionThresholdChange={onChange} useAutoCondense={true} />)
		const bar = screen.getByRole("slider")
		mockBarWidth(bar)
		fireEvent.click(bar, { clientX: 190 })
		expect(onChange).toHaveBeenCalledWith(0.95)
	})

	it("moves the threshold with the arrow keys, Home and End", () => {
		const onChange = vi.fn()
		render(<ContextWindow {...props} onCompactionThresholdChange={onChange} useAutoCondense={true} />)
		const bar = screen.getByRole("slider")
		expect(bar).toHaveAttribute("tabindex", "0")
		expect(bar).toHaveAttribute("aria-valuemin", "10")
		expect(bar).toHaveAttribute("aria-valuemax", "95")

		fireEvent.keyDown(bar, { key: "ArrowLeft" })
		expect(onChange).toHaveBeenLastCalledWith(0.85)
		fireEvent.keyDown(bar, { key: "ArrowLeft" })
		expect(onChange).toHaveBeenLastCalledWith(0.8)
		fireEvent.keyDown(bar, { key: "ArrowUp" })
		expect(onChange).toHaveBeenLastCalledWith(0.85)
		fireEvent.keyDown(bar, { key: "Home" })
		expect(onChange).toHaveBeenLastCalledWith(0.1)
		fireEvent.keyDown(bar, { key: "End" })
		expect(onChange).toHaveBeenLastCalledWith(0.95)
		fireEvent.keyDown(bar, { key: "a" })
		expect(onChange).toHaveBeenCalledTimes(5)
	})

	it("is not a slider while auto condense is off", () => {
		const onChange = vi.fn()
		render(<ContextWindow {...props} onCompactionThresholdChange={onChange} useAutoCondense={false} />)
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		const bar = screen.getByTestId("context-window-bar")
		mockBarWidth(bar)
		fireEvent.click(bar, { clientX: 60 })
		fireEvent.keyDown(bar, { key: "ArrowLeft" })
		expect(onChange).not.toHaveBeenCalled()
	})
})

describe("ContextWindow compact button", () => {
	beforeEach(() => {
		condense.mockClear()
	})

	it("runs the compact RPC after confirmation instead of sending /compact as a message", async () => {
		const onSendMessage = vi.fn()

		render(
			<ContextWindow
				contextWindow={200_000}
				lastApiReqTotalTokens={120_000}
				onSendMessage={onSendMessage}
				useAutoCondense={false}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /compact task/i }))
		fireEvent.click(screen.getByRole("button", { name: /^compact$/i }))

		await waitFor(() => expect(condense).toHaveBeenCalledWith({ value: "compact" }))
		expect(onSendMessage).not.toHaveBeenCalled()
	})
})

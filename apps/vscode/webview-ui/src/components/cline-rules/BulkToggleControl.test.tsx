import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import BulkToggleControl from "./BulkToggleControl"

describe("BulkToggleControl", () => {
	it("disables an empty list", () => {
		render(<BulkToggleControl kind="rules" onBusyChange={vi.fn()} onRefresh={vi.fn()} targets={[]} />)
		expect(screen.getByRole("switch", { name: "Toggle all rules" })).toBeDisabled()
	})

	it("serializes changes, skips unchanged entries and refreshes after the last save", async () => {
		let finishFirst!: () => void
		const first = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve
				}),
		)
		const unchanged = vi.fn()
		const last = vi.fn().mockResolvedValue({})
		const refresh = vi.fn().mockResolvedValue(undefined)
		const busy = vi.fn()
		render(
			<BulkToggleControl
				kind="rules"
				onBusyChange={busy}
				onRefresh={refresh}
				targets={[
					{ enabled: true, toggle: first },
					{ enabled: false, toggle: unchanged },
					{ enabled: true, toggle: last },
				]}
			/>,
		)
		const toggle = screen.getByRole("switch", { name: "Toggle all rules" })
		expect(toggle).toHaveAttribute("aria-checked", "true")
		fireEvent.click(toggle)
		expect(first).toHaveBeenCalledExactlyOnceWith(false)
		expect(last).not.toHaveBeenCalled()
		expect(refresh).not.toHaveBeenCalled()
		expect(toggle).toBeDisabled()
		fireEvent.click(toggle)
		expect(first).toHaveBeenCalledTimes(1)
		await act(async () => finishFirst())
		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
		expect(unchanged).not.toHaveBeenCalled()
		expect(last).toHaveBeenCalledExactlyOnceWith(false)
		expect(busy.mock.calls).toEqual([[true], [false]])
		expect(toggle).not.toBeDisabled()
	})

	it("continues after a failed entry, refreshes persisted state and shows the failure", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const failed = vi.fn().mockRejectedValue(new Error("read-only skill"))
		const saved = vi.fn().mockResolvedValue({})
		const refresh = vi.fn().mockResolvedValue(undefined)
		render(
			<BulkToggleControl
				kind="skills"
				onBusyChange={vi.fn()}
				onRefresh={refresh}
				targets={[
					{ enabled: false, toggle: failed },
					{ enabled: false, toggle: saved },
				]}
			/>,
		)
		fireEvent.click(screen.getByRole("switch", { name: "Toggle all skills" }))
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not update all skills (1 failed)"))
		expect(saved).toHaveBeenCalledExactlyOnceWith(true)
		expect(refresh).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("switch", { name: "Toggle all skills" })).not.toBeDisabled()
		log.mockRestore()
	})

	it("unlocks the controls and reports a failed refresh", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const busy = vi.fn()
		render(
			<BulkToggleControl
				kind="rules"
				onBusyChange={busy}
				onRefresh={vi.fn().mockRejectedValue(new Error("disconnected"))}
				targets={[{ enabled: true, toggle: vi.fn().mockResolvedValue({}) }]}
			/>,
		)
		fireEvent.click(screen.getByRole("switch", { name: "Toggle all rules" }))
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh rules"))
		expect(busy).toHaveBeenLastCalledWith(false)
		expect(screen.getByRole("switch", { name: "Toggle all rules" })).not.toBeDisabled()
		log.mockRestore()
	})
})

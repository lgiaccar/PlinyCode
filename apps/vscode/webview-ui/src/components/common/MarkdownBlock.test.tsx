import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ mode: "act" }),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {},
	StateServiceClient: {},
}))

vi.mock("@/components/common/MermaidBlock", () => ({
	default: () => <div>Diagram</div>,
}))

import MarkdownBlock from "./MarkdownBlock"

describe("MarkdownBlock reading layout", () => {
	it("keeps semantic Markdown and gives a wide table its own keyboard-scrollable region", () => {
		const { container } = render(
			<MarkdownBlock
				markdown={
					"# Heading\n\nA paragraph with [a link](https://example.com) and `inline code`.\n\n> A quote\n\n| Name | Detail |\n| --- | --- |\n| Item | A long value |"
				}
			/>,
		)

		expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toBeTruthy()
		expect(screen.getByRole("link", { name: "a link" }).getAttribute("href")).toBe("https://example.com")
		expect(container.querySelector("blockquote")?.textContent).toContain("A quote")
		expect(container.querySelector("p code")?.textContent).toBe("inline code")

		const tableRegion = screen.getByRole("region", { name: "Markdown table" })
		expect(tableRegion.getAttribute("tabindex")).toBe("0")
		expect(within(tableRegion).getByRole("table")).toBeTruthy()
		expect(within(tableRegion).getByRole("cell", { name: "A long value" })).toBeTruthy()
	})

	it("keeps code blocks and their copy control", () => {
		const { container } = render(<MarkdownBlock markdown={"```ts\nconst value = 1\n```"} />)

		expect(container.querySelector("pre code")?.textContent).toContain("const value = 1")
		expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy()
	})
})

import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ErrorRow from "./ErrorRow"

const mockNavigateToSettingsModelPicker = vi.hoisted(() => vi.fn())
const mockApiConfiguration = vi.hoisted(() => ({
	planModeApiProvider: "pliny",
	actModeApiProvider: "pliny",
	planModeApiModelId: "snps-provider/kimi-k2.6",
	actModeApiModelId: "snps-provider/kimi-k2.6",
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: mockApiConfiguration,
		mode: "act",
		providerModelsByProvider: {},
		startProviderModelsRequest: vi.fn(),
		applyProviderModelsResponse: vi.fn(),
		navigateToSettingsModelPicker: mockNavigateToSettingsModelPicker,
	}),
}))

// Mock EntitlementError component
vi.mock("@/components/chat/EntitlementError", () => ({
	default: ({ message }: { message: string }) => <div data-testid="entitlement-error">{message}</div>,
}))

// Mock ClineError
vi.mock("../../../../src/services/error/ClineError", () => ({
	ClineError: {
		parse: vi.fn(),
	},
	ClineErrorType: {
		Balance: "balance",
		RateLimit: "rateLimit",
		Auth: "auth",
		Entitlement: "entitlement",
		OrgClinePassRestriction: "orgClinePassRestriction",
		QuotaExceeded: "quotaExceeded",
	},
}))

describe("ErrorRow", () => {
	const mockMessage: ClineMessage = {
		ts: 123456789,
		type: "say",
		say: "error",
		text: "Test error message",
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders basic error message", () => {
		render(<ErrorRow errorType="error" message={mockMessage} />)

		expect(screen.getByText("Test error message")).toBeInTheDocument()
	})

	it("renders mistake limit reached error", () => {
		const mistakeMessage = { ...mockMessage, text: "Mistake limit reached" }
		render(<ErrorRow errorType="mistake_limit_reached" message={mistakeMessage} />)

		expect(screen.getByText("Mistake limit reached")).toBeInTheDocument()
	})

	it("renders diff error", () => {
		render(<ErrorRow errorType="diff_error" message={mockMessage} />)

		expect(
			screen.getByText("The model used search patterns that don't match anything in the file. Retrying..."),
		).toBeInTheDocument()
	})

	it("renders clineignore error", () => {
		const clineignoreMessage = { ...mockMessage, text: "/path/to/file.txt" }
		render(<ErrorRow errorType="clineignore_error" message={clineignoreMessage} />)

		expect(screen.getByText(/PlinyCode tried to access/)).toBeInTheDocument()
		expect(screen.getByText("/path/to/file.txt")).toBeInTheDocument()
	})

	describe("API error handling", () => {
		it("shows balance errors as a plain provider error", async () => {
			const mockClineError = {
				message: "Not enough credits available",
				providerId: "zai",
				isErrorType: vi.fn((type) => type === "balance"),
				_error: {
					code: "insufficient_credits",
					providerId: "zai",
					details: {
						current_balance: 0,
						message: "Not enough credits available",
					},
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Insufficient credits error" errorType="error" message={mockMessage} />)

			expect(screen.getByText(/\[zai\]/)).toBeInTheDocument()
		})

		it("renders rate limit error with request ID", async () => {
			const mockClineError = {
				message: "Rate limit exceeded",
				isErrorType: vi.fn((type) => type === "rateLimit"),
				_error: {
					request_id: "req_123456",
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Rate limit exceeded" errorType="error" message={mockMessage} />)

			expect(screen.getByText("Rate limit exceeded")).toBeInTheDocument()
			expect(screen.getByText("Request ID: req_123456")).toBeInTheDocument()
		})

		it("renders quota exceeded error", async () => {
			const mockClineError = {
				message: "Inference cap reached",
				isErrorType: vi.fn((type) => type === "quotaexceeded"),
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="The message" errorType="error" message="" />)
			expect(screen.getByText("Inference cap reached")).toBeInTheDocument()
		})

		it("renders entitlement error when ClineError detects ClineNotSubscribedError", async () => {
			const cliMessage =
				"No access to ClinePass subscription models yet. Subscribe to ClinePass, the low cost open weights model coding plan:"
			const mockClineError = {
				message: cliMessage,
				isErrorType: vi.fn((type) => type === "entitlement"),
				providerId: "cline-pass",
				_error: {
					message: cliMessage,
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage={cliMessage} errorType="error" message={mockMessage} />)

			expect(screen.getByTestId("entitlement-error")).toBeInTheDocument()
			expect(screen.getByText(cliMessage)).toBeInTheDocument()
			expect(screen.queryByText(/\[cline-pass\]/i)).not.toBeInTheDocument()
		})

		it("renders entitlement error when ClineError detects a raw required-plan message", async () => {
			const rawMessage = "403 Error 403: the user is not subscribed to required model plan"
			const mockClineError = {
				message: rawMessage,
				isErrorType: vi.fn((type) => type === "entitlement"),
				providerId: "cline-pass",
				_error: {
					message: rawMessage,
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage={rawMessage} errorType="error" message={mockMessage} />)

			expect(screen.getByTestId("entitlement-error")).toBeInTheDocument()
			expect(screen.getByText(rawMessage)).toBeInTheDocument()
		})

		it("shows a Cline sign-in error as a plain provider error", async () => {
			const mockClineError = {
				message: "Authentication failed",
				isErrorType: vi.fn((type) => type === "auth"),
				providerId: "cline",
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Authentication failed" errorType="error" message={mockMessage} />)

			expect(screen.getByText(/Authentication failed/)).toBeInTheDocument()
			expect(screen.queryByText(/Sign in/)).not.toBeInTheDocument()
		})

		it("renders PowerShell troubleshooting link when error mentions PowerShell", async () => {
			const mockClineError = {
				message: "PowerShell is not recognized as an internal or external command",
				isErrorType: vi.fn(() => false),
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(
				<ErrorRow
					apiRequestFailedMessage="PowerShell is not recognized as an internal or external command"
					errorType="error"
					message={mockMessage}
				/>,
			)

			expect(screen.getByText(/PowerShell is not recognized/)).toBeInTheDocument()
			expect(screen.getByText("troubleshooting guide")).toBeInTheDocument()
			expect(screen.getByRole("link", { name: "troubleshooting guide" })).toHaveAttribute(
				"href",
				"https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22",
			)
		})

		it("handles apiReqStreamingFailedMessage instead of apiRequestFailedMessage", async () => {
			const mockClineError = {
				message: "Streaming failed",
				isErrorType: vi.fn(() => false),
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiReqStreamingFailedMessage="Streaming failed" errorType="error" message={mockMessage} />)

			expect(screen.getByText("Streaming failed")).toBeInTheDocument()
		})

		it("falls back to regular error message when ClineError.parse returns null", async () => {
			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(undefined)

			render(<ErrorRow apiRequestFailedMessage="Some API error" errorType="error" message={mockMessage} />)

			// When ClineError.parse returns null, we display the raw error message for non-PlinyCode providers
			// Since clineError is undefined, isClineUsageBillingProvider is false, so we show the raw apiRequestFailedMessage
			expect(screen.getByText("Some API error")).toBeInTheDocument()
		})

		it("renders regular error message when no API error messages are provided", () => {
			render(<ErrorRow errorType="error" message={mockMessage} />)

			expect(screen.getByText("Test error message")).toBeInTheDocument()
		})
	})
})

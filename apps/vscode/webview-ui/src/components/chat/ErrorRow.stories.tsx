import { ClineMessage } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useMemo } from "react"
import { expect, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import ErrorRow from "./ErrorRow"

// Mock data factories
const createMockMessage = (overrides: Partial<ClineMessage> = {}): ClineMessage => ({
	ts: Date.now(),
	type: "say",
	say: "error",
	text: "An error occurred while processing your request.",
	...overrides,
})

const createMockExtensionState = (overrides: any = {}) => ({
	version: "1.0.0",
	clineMessages: [],
	taskHistory: [],
	...overrides,
})

// Reusable decorators
const createStoryDecorator =
	(extensionOverrides: any = {}) =>
	(Story: any) => {
		const mockExtensionState = useMemo(() => createMockExtensionState(extensionOverrides), [])

		return createStorybookDecorator(mockExtensionState, "p-4")(Story)
	}

const meta: Meta<typeof ErrorRow> = {
	title: "Views/Components/ErrorRow",
	component: ErrorRow,
	parameters: {
		docs: {
			description: {
				component:
					"Displays different types of error messages in the chat interface, including API errors, spend limit errors, diff errors, and clineignore errors. Handles special error parsing for Cline provider errors.",
			},
		},
	},
	decorators: [createStoryDecorator()],
}

export default meta
type Story = StoryObj<typeof ErrorRow>

// Interactive plain text error story with configurable args and presets
export const Default: Story = {
	args: {
		message: createMockMessage({ text: "Something went wrong while executing the command." }),
		errorType: "error",
		apiRequestFailedMessage: undefined,
	},
	argTypes: {
		errorType: {
			control: { type: "select" },
			options: ["error", "mistake_limit_reached", "diff_error", "clineignore_error"],
			description: "Type of error to display",
		},
		message: {
			control: { type: "object" },
			description: "Message object containing error text and metadata",
		},
		apiRequestFailedMessage: {
			control: { type: "select" },
			options: [
				// Empty option for no error message
				"",
				// PowerShell error
				"PowerShell is not recognized as an internal or external command, operable program or batch file.",
				JSON.stringify({
					request_id: "has-request-id",
					message: "error message.",
					code: "random_code",
				}),
			],
		},
	},
	parameters: {
		docs: {
			description: {
				story: "Interactive story for testing different plain text error types and messages. Use the preset dropdown to quickly test common scenarios, or manually configure the error type and message object.",
			},
		},
	},
}

// API request errors
export const ApiRequestFailed: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage:
			"Network error: Unable to connect to the API server. Please check your internet connection and try again.",
	},
}

export const ApiStreamingFailed: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiReqStreamingFailedMessage: "Streaming error: Connection was interrupted while receiving the response.",
	},
}

// Cline-specific errors
export const ClineRateLimitError: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage: JSON.stringify({
			message: "Rate limit exceeded. Please wait before making another request.",
			request_id: "req_987654321",
			providerId: "cline",
		}),
	},
}

export const ClineSpendLimitDaily: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage: JSON.stringify({
			message: "$20.00 daily limit has been reached.",
			status: 429,
			code: "SPEND_LIMIT_EXCEEDED",
			providerId: "cline",
			details: {
				code: "SPEND_LIMIT_EXCEEDED",
				limit_scope: "user",
				budget_period: "daily",
				limit_usd: 20.0,
				spent_usd: 20.5,
				resets_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
				message: "$20.00 daily limit has been reached.",
			},
		}),
	},
}

export const ClineSpendLimitMonthly: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage: JSON.stringify({
			message: "$100.00 monthly limit has been reached.",
			status: 429,
			code: "SPEND_LIMIT_EXCEEDED",
			providerId: "cline",
			details: {
				code: "SPEND_LIMIT_EXCEEDED",
				limit_scope: "user",
				budget_period: "monthly",
				limit_usd: 100.0,
				spent_usd: 103.22,
				resets_at: null,
				message: "$100.00 monthly limit has been reached.",
			},
		}),
	},
}

export const ClineSpendLimitMinimal: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage: JSON.stringify({
			message: "Spend limit reached.",
			status: 429,
			code: "SPEND_LIMIT_EXCEEDED",
			providerId: "cline",
			details: {
				code: "SPEND_LIMIT_EXCEEDED",
				message: "Spend limit reached.",
			},
		}),
	},
}

// ClinePass entitlement error (user not subscribed to a required model plan)
export const ClinePassEntitlementError: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage:
			"No access to ClinePass subscription models yet. Subscribe to ClinePass, the low cost open weights model coding plan:",
	},
	parameters: {
		docs: {
			description: {
				story: "ClinePass model returns the SDK ClineNotSubscribedError message when the user is not subscribed. A human-readable message and a retry button are shown.",
			},
		},
	},
}

export const TroubleshootingLink: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage:
			"PowerShell is not recognized as an internal or external command. Please check your system configuration.",
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement)

		// Find the troubleshooting link
		const troubleshootingLink = canvas.getByRole("link", { name: /troubleshooting guide/i })
		await expect(troubleshootingLink).toBeInTheDocument()

		// Verify link attributes
		await expect(troubleshootingLink).toHaveAttribute("href")
		await expect(troubleshootingLink).toHaveClass("underline")
	},
}

// Keep this one as it has specific testing logic for request ID
export const ErrorWithRequestId: Story = {
	args: {
		message: createMockMessage(),
		errorType: "error",
		apiRequestFailedMessage: JSON.stringify({
			message: "An unexpected error occurred while processing your request.",
			request_id: "req_detailed_123456",
			providerId: "cline",
		}),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement)

		// Verify error message is displayed
		const errorMessage = canvas.getByText(/an unexpected error occurred/i)
		await expect(errorMessage).toBeInTheDocument()

		// Verify request ID is displayed
		const requestId = canvas.getByText(/request id: req_detailed_123456/i)
		await expect(requestId).toBeInTheDocument()
	},
}

import type { ApiConfiguration } from "@shared/api"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExtensionState } from "@/context/ExtensionStateContext"
import ApiOptions from "../ApiOptions"

const handleModeFieldChange = vi.fn(async () => {})

vi.mock("@/hooks/useProviderListings", () => ({
	useProviderListings: vi.fn(() => ({ providers: [], isLoading: false, error: undefined, refresh: vi.fn() })),
}))

vi.mock("../providers/GenericProviderSettings", () => ({
	GenericProviderSettings: vi.fn((props) => <div data-testid="generic-provider-settings">{props.providerName}</div>),
}))

vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleModeFieldChange }),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

function mockApiConfiguration(apiConfiguration: Partial<ApiConfiguration>) {
	vi.mocked(useExtensionState).mockReturnValue({ apiConfiguration } as ReturnType<typeof useExtensionState>)
}

describe("ApiOptions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the Pliny settings", () => {
		mockApiConfiguration({ planModeApiProvider: "pliny", actModeApiProvider: "pliny" })

		render(<ApiOptions currentMode="plan" showModelOptions={true} />)

		expect(screen.getByTestId("generic-provider-settings")).toHaveTextContent("Pliny")
		expect(handleModeFieldChange).not.toHaveBeenCalled()
	})

	it("pins a provider stored by an older version to Pliny", () => {
		mockApiConfiguration({
			planModeApiProvider: "requesty",
			actModeApiProvider: "pliny",
		} as unknown as Partial<ApiConfiguration>)

		render(<ApiOptions currentMode="act" showModelOptions={true} />)

		expect(handleModeFieldChange).toHaveBeenCalledWith(
			{ plan: "planModeApiProvider", act: "actModeApiProvider" },
			"pliny",
			"act",
		)
	})
})

import type { Mode } from "@shared/storage/types"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useMemo } from "react"
import styled from "styled-components"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderListings } from "@/hooks/useProviderListings"
import { OPENROUTER_MODEL_PICKER_Z_INDEX } from "./OpenRouterModelPicker"
import { GenericProviderSettings } from "./providers/GenericProviderSettings"
import { getFallbackGenericProviderSettings, getGenericProviderSettings } from "./providers/providerSettingsRegistry"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"

interface ApiOptionsProps {
	showModelOptions: boolean
	apiErrorMessage?: string
	modelIdErrorMessage?: string
	isPopup?: boolean
	currentMode: Mode
	initialModelTab?: "recommended" | "free"
}

// This is necessary to ensure dropdown opens downward, important for when this is used in popup
export const DROPDOWN_Z_INDEX = OPENROUTER_MODEL_PICKER_Z_INDEX + 2 // Higher than the OpenRouterModelPicker's and ModelSelectorTooltip's z-index

export const DropdownContainer = styled.div<{ zIndex?: number }>`
	position: relative;
	z-index: ${(props) => props.zIndex || DROPDOWN_Z_INDEX};

	// Force dropdowns to open downward
	& vscode-dropdown::part(listbox) {
		position: absolute !important;
		top: 100% !important;
		bottom: auto !important;
	}
`

declare module "vscode" {
	interface LanguageModelChatSelector {
		vendor?: string
		family?: string
		version?: string
		id?: string
	}
}

const ApiOptions = ({ showModelOptions, apiErrorMessage, modelIdErrorMessage, isPopup, currentMode }: ApiOptionsProps) => {
	// Use full context state for immediate save payload
	const { apiConfiguration } = useExtensionState()

	const selectedProvider = "pliny"
	const { providers: catalogProviderListings } = useProviderListings()
	const catalogProviderListing = useMemo(
		() => catalogProviderListings.find((provider) => provider.id === selectedProvider),
		[catalogProviderListings, selectedProvider],
	)

	const { handleModeFieldChange } = useApiConfigurationHandlers()

	// Hard-pin settings UI onto Pliny if legacy state still points elsewhere.
	useEffect(() => {
		const plan = apiConfiguration?.planModeApiProvider
		const act = apiConfiguration?.actModeApiProvider
		if (plan !== "pliny" || act !== "pliny") {
			void handleModeFieldChange({ plan: "planModeApiProvider", act: "actModeApiProvider" }, "pliny", currentMode)
		}
	}, [apiConfiguration?.planModeApiProvider, apiConfiguration?.actModeApiProvider, currentMode, handleModeFieldChange])

	const genericProviderSettings =
		getGenericProviderSettings(selectedProvider, catalogProviderListing) ??
		getFallbackGenericProviderSettings(selectedProvider)

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 5,
				marginBottom: isPopup ? -10 : 0,
			}}>
			<style>
				{`
				.provider-item-highlight {
					background-color: var(--vscode-editor-findMatchHighlightBackground);
					color: inherit;
				}
				`}
			</style>
			<DropdownContainer className="dropdown-container">
				<label htmlFor="api-provider">
					<span style={{ fontWeight: 500 }}>API Provider</span>
				</label>
				<VSCodeTextField
					disabled
					readOnly
					style={{
						width: "100%",
						zIndex: DROPDOWN_Z_INDEX,
						position: "relative",
						minWidth: 130,
					}}
					value="Pliny"
				/>
			</DropdownContainer>

			{apiConfiguration && (
				<GenericProviderSettings
					allowsCustomIds={genericProviderSettings?.allowsCustomIds ?? false}
					currentMode={currentMode}
					isPopup={isPopup}
					providerId="pliny"
					providerName={genericProviderSettings?.providerName ?? "Pliny"}
					showModelOptions={showModelOptions}
				/>
			)}

			{apiErrorMessage && (
				<p
					style={{
						margin: "-10px 0 4px 0",
						fontSize: 12,
						color: "var(--vscode-errorForeground)",
					}}>
					{apiErrorMessage}
				</p>
			)}
			{modelIdErrorMessage && (
				<p
					style={{
						margin: "-10px 0 4px 0",
						fontSize: 12,
						color: "var(--vscode-errorForeground)",
					}}>
					{modelIdErrorMessage}
				</p>
			)}
		</div>
	)
}

export default ApiOptions

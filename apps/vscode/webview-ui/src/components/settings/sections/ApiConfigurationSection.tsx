import { PLINY_FREE_AUTO_RULES_URI } from "@shared/pliny"
import { StringRequest } from "@shared/proto/cline/common"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { Mode } from "@shared/storage/types"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient, StateServiceClient } from "@/services/grpc-client"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
import ApiOptions from "../ApiOptions"
import Section from "../Section"
import { usePlinyUnlockFreeModels, usePlinyUnlockPaidModels } from "../utils/plinyModelFilter"
import { syncModeConfigurations } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

const ApiConfigurationSection = ({ renderSectionHeader, initialModelTab }: ApiConfigurationSectionProps) => {
	const { planActSeparateModelsSetting, mode, apiConfiguration } = useExtensionState()
	const [currentTab, setCurrentTab] = useState<Mode>(mode)
	const { handleFieldsChange } = useApiConfigurationHandlers()
	const [unlockPlinyPaid, setUnlockPlinyPaid] = usePlinyUnlockPaidModels()
	const [unlockPlinyFree, setUnlockPlinyFree] = usePlinyUnlockFreeModels()
	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				{/* Tabs container */}
				{planActSeparateModelsSetting ? (
					<div className="rounded-md mb-5">
						<div className="flex gap-px mb-[10px] -mt-2 border-0 border-b border-solid border-(--vscode-panel-border)">
							<TabButton
								disabled={currentTab === "plan"}
								isActive={currentTab === "plan"}
								onClick={() => setCurrentTab("plan")}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								Plan Mode
							</TabButton>
							<TabButton
								disabled={currentTab === "act"}
								isActive={currentTab === "act"}
								onClick={() => setCurrentTab("act")}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								Act Mode
							</TabButton>
						</div>

						{/* Content container */}
						<div className="-mb-3">
							<ApiOptions currentMode={currentTab} initialModelTab={initialModelTab} showModelOptions={true} />
						</div>
					</div>
				) : (
					<ApiOptions currentMode={mode} initialModelTab={initialModelTab} showModelOptions={true} />
				)}

				<div className="mb-[5px]">
					<VSCodeCheckbox
						checked={unlockPlinyFree}
						className="mb-[5px]"
						onChange={(e: any) => setUnlockPlinyFree(e.target.checked === true)}>
						Unlock Pliny free models
					</VSCodeCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						<code>auto-free</code> (the automatic free router) is always shown and is the recommended default. Enable
						this to also list the individual free self-hosted models (<code>snps-provider</code>) in the model picker.
					</p>
				</div>

				<div className="mb-[5px]">
					<VSCodeCheckbox
						checked={unlockPlinyPaid}
						className="mb-[5px]"
						onChange={(e: any) => setUnlockPlinyPaid(e.target.checked === true)}>
						Unlock Pliny paid models
					</VSCodeCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Enable this to list paid hosted models (Bedrock, Azure, GCP, Vertex) in the model picker, together with{" "}
						<code>auto-paid-balanced</code>: the router that sends difficult work to paid high-end models and simple
						requests and sub-agents to cheaper or free ones.
					</p>
				</div>

				<div className="mb-[5px]">
					<label className="block font-medium mb-[5px]">Routing rules</label>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						<code>auto-free</code> picks a free model for each request and switches to a backup when one fails. Edit
						the rules file to change which model is used when; it takes effect on the next request, with no restart.
						The other profiles, including <code>auto-paid-balanced</code>, have their own files: run{" "}
						<code>PlinyCode: Open Routing Rules</code> from the command palette.{" "}
						<VSCodeLink
							className="inline text-inherit"
							href="#"
							onClick={(e: React.MouseEvent) => {
								e.preventDefault()
								FileServiceClient.openFile(StringRequest.create({ value: PLINY_FREE_AUTO_RULES_URI })).catch(
									(err) => console.error("Failed to open FreeAuto rules file:", err),
								)
							}}>
							Open rules file
						</VSCodeLink>
					</p>
				</div>

				<div className="mb-[5px]">
					<VSCodeCheckbox
						checked={planActSeparateModelsSetting}
						className="mb-[5px]"
						onChange={async (e: any) => {
							const checked = e.target.checked === true
							try {
								// If unchecking the toggle, wait a bit for state to update, then sync configurations
								if (!checked) {
									await syncModeConfigurations(apiConfiguration, currentTab, handleFieldsChange)
								}
								await StateServiceClient.updateSettings(
									UpdateSettingsRequest.create({
										planActSeparateModelsSetting: checked,
									}),
								)
							} catch (error) {
								console.error("Failed to update separate models setting:", error)
							}
						}}>
						Use different models for Plan and Act modes
					</VSCodeCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Switching between Plan and Act mode will persist the API and model used in the previous mode. This may be
						helpful e.g. when using a strong reasoning model to architect a plan for a cheaper coding model to act on.
					</p>
				</div>
			</Section>
		</div>
	)
}

export default ApiConfigurationSection

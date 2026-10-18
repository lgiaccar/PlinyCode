import {
	describeModelTuning,
	MODEL_TUNING_EFFORTS,
	type ModelTuning,
	modelTuningFor,
	modelTuningOptions,
} from "@shared/model-tuning"
import { isPlinyRouterModelId } from "@shared/pliny"
import { SetModelTuningRequest } from "@shared/proto/cline/models"
import type { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { SlidersHorizontalIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useClickAway, useWindowSize } from "react-use"
import PopupModalContainer from "@/components/common/PopupModalContainer"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { ModelsServiceClient } from "@/services/grpc-client"

interface Choice<T> {
	value: T
	label: string
}

function Segments<T>({
	label,
	choices,
	value,
	onChange,
}: {
	label: string
	choices: Choice<T>[]
	value: T
	onChange: (value: T) => void
}) {
	return (
		<div className="flex items-center justify-between gap-3 py-1">
			<span className="text-xs text-[var(--vscode-descriptionForeground)]">{label}</span>
			<div
				aria-label={label}
				className="flex overflow-hidden rounded border border-[var(--vscode-editorGroup-border)]"
				role="radiogroup">
				{choices.map((choice) => {
					const selected = choice.value === value
					return (
						<button
							aria-checked={selected}
							className="px-2 py-0.5 text-[11px] cursor-pointer border-0"
							key={choice.label}
							onClick={() => onChange(choice.value)}
							role="radio"
							style={{
								background: selected ? "var(--vscode-button-background)" : "transparent",
								color: selected ? "var(--vscode-button-foreground)" : "var(--vscode-foreground)",
							}}
							type="button">
							{choice.label}
						</button>
					)
				})}
			</div>
		</div>
	)
}

const formatTokens = (tokens: number) => `${Math.round(tokens / 1000)}k`

/**
 * The sliders button next to the model picker: reasoning on or off, the
 * effort level and a smaller context budget for the selected model. Only the
 * controls the model's measured switches support are offered; a router gets
 * the context budget alone, since its routes choose the reasoning per call.
 */
export function ModelTuningButton({ mode }: { mode: Mode }) {
	const { modelTuning } = useExtensionState()
	const { selectedModelId, selectedModelInfo } = useNormalizedApiConfiguration(mode)
	const [isVisible, setIsVisible] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)
	const buttonRef = useRef<HTMLDivElement>(null)
	const { width: viewportWidth, height: viewportHeight } = useWindowSize()
	const [arrowPosition, setArrowPosition] = useState(0)
	const [menuPosition, setMenuPosition] = useState(0)

	useClickAway(containerRef, () => setIsVisible(false))

	useEffect(() => {
		if (isVisible && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect()
			setArrowPosition(document.documentElement.clientWidth - (rect.left + rect.width / 2) - 5)
			setMenuPosition(rect.top + 1)
		}
	}, [isVisible, viewportWidth, viewportHeight])

	if (!selectedModelId) {
		return null
	}

	const isRouter = isPlinyRouterModelId(selectedModelId)
	const tuning = modelTuningFor(modelTuning, selectedModelId) ?? {}
	const options = modelTuningOptions(selectedModelInfo, isRouter)
	const summary = describeModelTuning(tuning)

	const save = (next: ModelTuning) => {
		ModelsServiceClient.setModelTuning(
			SetModelTuningRequest.create({
				modelId: selectedModelId,
				thinking: next.thinking,
				effort: next.effort,
				maxInputTokens: next.maxInputTokens,
			}),
		).catch((error) => console.error("Failed to save the model tuning:", error))
	}

	const thinkingValue = tuning.thinking === undefined ? "default" : tuning.thinking ? "on" : "off"
	const thinkingChoices: Choice<string>[] = [
		{ value: "default", label: "Default" },
		...(options.canTurnOn ? [{ value: "on", label: "On" }] : []),
		...(options.canTurnOff ? [{ value: "off", label: "Off" }] : []),
	]
	const contextChoices: Choice<number | undefined>[] = [
		{ value: undefined, label: "Full" },
		...options.contextPresets.map((preset) => ({ value: preset as number | undefined, label: formatTokens(preset) })),
	]

	return (
		<div className="inline-flex min-w-0 items-center" ref={containerRef}>
			<div className="inline-flex items-center" ref={buttonRef}>
				<Tooltip>
					{!isVisible && <TooltipContent>{summary ? `Model tuning: ${summary}` : "Tune the model"}</TooltipContent>}
					<TooltipTrigger>
						<VSCodeButton
							appearance="icon"
							aria-label="Tune the model"
							className="p-0 m-0 flex items-center"
							data-testid="model-tuning-button"
							onClick={() => setIsVisible(!isVisible)}>
							<SlidersHorizontalIcon
								size={12}
								style={{ color: summary ? "var(--vscode-textLink-foreground)" : undefined }}
							/>
						</VSCodeButton>
					</TooltipTrigger>
				</Tooltip>
			</div>

			{isVisible && (
				<PopupModalContainer $arrowPosition={arrowPosition} $menuPosition={menuPosition}>
					<div className="px-3 pt-2 pb-3" data-testid="model-tuning-popover">
						<div className="mb-1 text-sm font-medium">Tune {selectedModelInfo?.name ?? selectedModelId}</div>
						{thinkingChoices.length > 1 && (
							<Segments
								choices={thinkingChoices}
								label="Thinking"
								onChange={(value) =>
									save({
										...tuning,
										thinking: value === "default" ? undefined : value === "on",
										...(value === "off" ? { effort: undefined } : {}),
									})
								}
								value={thinkingValue}
							/>
						)}
						{options.effort && tuning.thinking !== false && (
							<Segments
								choices={[
									{ value: undefined, label: "Default" },
									...MODEL_TUNING_EFFORTS.map((effort) => ({
										value: effort as ModelTuning["effort"],
										label: effort[0].toUpperCase() + effort.slice(1),
									})),
								]}
								label="Effort"
								onChange={(effort) => save({ ...tuning, effort })}
								value={tuning.effort}
							/>
						)}
						{contextChoices.length > 1 && (
							<Segments
								choices={contextChoices}
								label="Context"
								onChange={(maxInputTokens) => save({ ...tuning, maxInputTokens })}
								value={tuning.maxInputTokens}
							/>
						)}
						<div className="mt-1.5 text-[11px] text-[var(--vscode-descriptionForeground)]">
							{isRouter
								? "Thinking and effort are chosen per turn by the router: plan turns think, quick turns don't. A smaller context compacts the conversation sooner."
								: thinkingChoices.length > 1 || options.effort
									? "Applies to every conversation on this model. A smaller context compacts the conversation sooner."
									: "This model's reasoning cannot be changed through the gateway. A smaller context compacts the conversation sooner."}
						</div>
					</div>
				</PopupModalContainer>
			)}
		</div>
	)
}

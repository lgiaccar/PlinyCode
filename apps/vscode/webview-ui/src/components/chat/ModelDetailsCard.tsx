import type { ModelInfo } from "@shared/api"
import { isPlinyRouterModelId } from "@shared/pliny"
import type React from "react"
import styled from "styled-components"
import { formatCompactContext, formatParameters, formatPricePerMillion } from "@/components/settings/utils/pricingUtils"

const Card = styled.div`
	padding: 8px 10px;
	font-size: 11px;
	line-height: 1.4;
	color: var(--vscode-foreground);
	background: var(--vscode-editorHoverWidget-background, var(--vscode-dropdown-background));
	border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-dropdown-border));
	border-radius: 4px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
`

const Header = styled.div`
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 6px;
`

const Title = styled.span`
	font-weight: 600;
	font-size: 12px;
`

const Badge = styled.span`
	padding: 0 4px;
	border-radius: 3px;
	font-size: 9px;
	text-transform: uppercase;
	color: var(--vscode-badge-foreground);
	background: var(--vscode-badge-background);
`

const ModelId = styled.div`
	margin-top: 1px;
	font-size: 10px;
	font-family: var(--vscode-editor-font-family);
	color: var(--vscode-descriptionForeground);
	overflow-wrap: anywhere;
`

const Summary = styled.p`
	margin: 6px 0 0;
`

const Muted = styled.p`
	margin: 4px 0 0;
	font-size: 10px;
	color: var(--vscode-descriptionForeground);
`

const Facts = styled.dl`
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 2px 10px;
	margin: 8px 0 0;
`

const Label = styled.dt`
	color: var(--vscode-descriptionForeground);
`

const Value = styled.dd`
	margin: 0;
`

interface ModelDetailsCardProps {
	modelId: string
	modelInfo: ModelInfo
}

/**
 * Everything a user needs to pick a model: what it is good and bad at, how
 * much it can read and write, how big it is, and what a million tokens cost.
 */
export const ModelDetailsCard: React.FC<ModelDetailsCardProps> = ({ modelId, modelInfo }) => {
	const isRouter = isPlinyRouterModelId(modelId)
	const [summary, ...rest] = (modelInfo.description ?? "").split("\n\n")
	const hosting = rest.join(" ")
	const isFree = !modelInfo.pricingUnavailable && !modelInfo.inputPrice && !modelInfo.outputPrice

	const context = modelInfo.contextWindow
		? `${formatCompactContext(modelInfo.contextWindow)} tokens${
				modelInfo.maxTokens ? ` · max output ${formatCompactContext(modelInfo.maxTokens)}` : ""
			}`
		: "Unknown"
	const parameters = formatParameters(modelInfo) ?? (isRouter ? "Depends on the routed model" : "Not disclosed")

	return (
		<Card data-testid="model-details-card">
			<Header>
				<Title>{modelInfo.name || modelId}</Title>
				{isRouter && <Badge>Router</Badge>}
				{isFree ? <Badge>Free</Badge> : <Badge>Paid</Badge>}
				{modelInfo.supportsImages && <Badge>Images</Badge>}
				{modelInfo.supportsReasoning && <Badge>Reasoning</Badge>}
			</Header>
			<ModelId>{modelId}</ModelId>
			{summary && <Summary>{summary}</Summary>}
			<Facts>
				<Label>Context</Label>
				<Value>{context}</Value>
				<Label>Parameters</Label>
				<Value>{parameters}</Value>
				{modelInfo.pricingUnavailable ? (
					<>
						<Label>Price</Label>
						<Value>{isRouter ? "Varies by routed model" : "Unknown"}</Value>
					</>
				) : (
					<>
						<Label>Input</Label>
						<Value>{formatPricePerMillion(modelInfo.inputPrice)}</Value>
						<Label>Cached input</Label>
						<Value>{isFree ? "Free" : formatPricePerMillion(modelInfo.cacheReadsPrice)}</Value>
						{!isFree && modelInfo.cacheWritesPrice !== undefined && (
							<>
								<Label>Cache write</Label>
								<Value>{formatPricePerMillion(modelInfo.cacheWritesPrice)}</Value>
							</>
						)}
						<Label>Output</Label>
						<Value>{formatPricePerMillion(modelInfo.outputPrice)}</Value>
					</>
				)}
			</Facts>
			{modelInfo.pricingNote && <Muted>{modelInfo.pricingNote}</Muted>}
			{hosting && <Muted>{hosting}</Muted>}
		</Card>
	)
}

export default ModelDetailsCard

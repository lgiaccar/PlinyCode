import { StringRequest } from "@shared/proto/cline/common"
import type { Mode } from "@shared/storage/types"
import { ChevronDown } from "lucide-react"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModels } from "@/hooks/useProviderModels"
import { StateServiceClient } from "@/services/grpc-client"

const PLINY_PROVIDER_ID = "pliny"

const StarIcon = ({ isFavorite, onClick }: { isFavorite: boolean; onClick: (e: React.MouseEvent) => void }) => {
	return (
		<button
			onClick={onClick}
			style={{
				background: "none",
				border: "none",
				padding: 0,
				cursor: "pointer",
				color: isFavorite ? "var(--vscode-terminal-ansiBlue)" : "var(--vscode-descriptionForeground)",
				fontSize: "13px",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				userSelect: "none",
				WebkitUserSelect: "none",
				flexShrink: 0,
			}}
			type="button">
			{isFavorite ? "★" : "☆"}
		</button>
	)
}

const DropdownContainer = styled.div`
	position: relative;
	display: inline-flex;
	min-width: 0;
	max-width: 100%;
`

const TriggerButton = styled.button`
	padding: 0 2px;
	height: 20px;
	min-width: 0;
	cursor: pointer;
	text-decoration: none;
	color: var(--vscode-descriptionForeground);
	display: flex;
	align-items: center;
	gap: 2px;
	font-size: 10px;
	outline: none;
	user-select: none;
	background: none;
	border: none;

	&:hover,
	&:focus {
		color: var(--vscode-foreground);
		text-decoration: underline;
		outline: none;
	}
`

const TriggerLabel = styled.span`
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

const DropdownMenu = styled.div`
	position: absolute;
	bottom: calc(100% + 4px);
	left: 0;
	min-width: 240px;
	max-width: 360px;
	max-height: 320px;
	overflow-y: auto;
	background: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-dropdown-border);
	border-radius: 4px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
	z-index: 1000;
`

const SearchInput = styled.input`
	width: 100%;
	box-sizing: border-box;
	padding: 6px 8px;
	border: none;
	border-bottom: 1px solid var(--vscode-dropdown-border);
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	font-size: 11px;
	outline: none;
`

const ModelRow = styled.div<{ isSelected?: boolean }>`
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 8px;
	cursor: pointer;
	font-size: 11px;
	color: var(--vscode-foreground);
	background: ${(props) => (props.isSelected ? "var(--vscode-list-activeSelectionBackground)" : "transparent")};

	&:hover {
		background: ${(props) => (props.isSelected ? "var(--vscode-list-activeSelectionBackground)" : "var(--vscode-list-hoverBackground)")};
	}
`

const ModelName = styled.span`
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

const SectionLabel = styled.div`
	padding: 4px 8px 2px;
	font-size: 9px;
	font-weight: 600;
	text-transform: uppercase;
	color: var(--vscode-descriptionForeground);
`

const EmptyState = styled.div`
	padding: 12px 8px;
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	text-align: center;
`

interface ConversationModelPickerProps {
	mode: Mode
}

export const ConversationModelPicker: React.FC<ConversationModelPickerProps> = ({ mode }) => {
	const { favoritedModelIds } = useExtensionState()
	const { selectedModelId } = useNormalizedApiConfiguration(mode)
	const { models: plinyModels } = useProviderModels(PLINY_PROVIDER_ID)
	const { commitSelection } = useProviderConfig(PLINY_PROVIDER_ID)

	const [isOpen, setIsOpen] = useState(false)
	const [searchTerm, setSearchTerm] = useState("")
	const containerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!isOpen) return
		const handleClickOutside = (event: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
				setIsOpen(false)
			}
		}
		document.addEventListener("mousedown", handleClickOutside)
		return () => document.removeEventListener("mousedown", handleClickOutside)
	}, [isOpen])

	const modelEntries = useMemo(() => {
		return Object.entries(plinyModels).map(([id]) => ({
			id,
			name: id,
		}))
	}, [plinyModels])

	const sortedModels = useMemo(() => {
		const favSet = new Set(favoritedModelIds || [])
		const favOrdered = (favoritedModelIds || [])
			.map((id) => modelEntries.find((m) => m.id === id))
			.filter((m): m is { id: string; name: string } => m !== undefined)
		const rest = modelEntries.filter((m) => !favSet.has(m.id))
		rest.sort((a, b) => a.name.localeCompare(b.name))
		return { favorited: favOrdered, rest }
	}, [modelEntries, favoritedModelIds])

	const filteredFavorites = useMemo(() => {
		if (!searchTerm.trim()) return sortedModels.favorited
		const term = searchTerm.toLowerCase()
		return sortedModels.favorited.filter((m) => m.name.toLowerCase().includes(term) || m.id.toLowerCase().includes(term))
	}, [sortedModels.favorited, searchTerm])

	const filteredRest = useMemo(() => {
		if (!searchTerm.trim()) return sortedModels.rest
		const term = searchTerm.toLowerCase()
		return sortedModels.rest.filter((m) => m.name.toLowerCase().includes(term) || m.id.toLowerCase().includes(term))
	}, [sortedModels.rest, searchTerm])

	const handleSelectModel = (modelId: string) => {
		commitSelection(mode, { providerId: PLINY_PROVIDER_ID, modelId }).catch((error) =>
			console.error("Failed to commit model selection:", error),
		)
		setIsOpen(false)
	}

	const toggleFavorite = (e: React.MouseEvent, modelId: string) => {
		e.stopPropagation()
		StateServiceClient.toggleFavoriteModel(StringRequest.create({ value: modelId })).catch((error) =>
			console.error("Failed to toggle favorite model:", error),
		)
	}

	const displayName = selectedModelId || "Select model..."

	return (
		<DropdownContainer ref={containerRef}>
			<TriggerButton onClick={() => setIsOpen(!isOpen)} title="Select model" type="button">
				<TriggerLabel>{displayName}</TriggerLabel>
				<ChevronDown size={10} style={{ flexShrink: 0 }} />
			</TriggerButton>
			{isOpen && (
				<DropdownMenu role="listbox">
					<SearchInput
						autoFocus
						onChange={(e) => setSearchTerm(e.target.value)}
						placeholder="Search models..."
						type="text"
						value={searchTerm}
					/>
					{modelEntries.length === 0 ? (
						<EmptyState>Loading models...</EmptyState>
					) : (
						<>
							{filteredFavorites.length > 0 && (
								<>
									<SectionLabel>Favorites</SectionLabel>
									{filteredFavorites.map((m) => {
										const isFavorite = (favoritedModelIds || []).includes(m.id)
										const isSelected = m.id === selectedModelId
										return (
											<ModelRow
												isSelected={isSelected}
												key={`fav-${m.id}`}
												onClick={() => handleSelectModel(m.id)}
												role="option">
												<StarIcon isFavorite={isFavorite} onClick={(e) => toggleFavorite(e, m.id)} />
												<ModelName title={m.id}>{m.name}</ModelName>
											</ModelRow>
										)
									})}
								</>
							)}
							{filteredRest.length > 0 && (
								<>
									{filteredFavorites.length > 0 && <SectionLabel>All Models</SectionLabel>}
									{filteredRest.map((m) => {
										const isFavorite = (favoritedModelIds || []).includes(m.id)
										const isSelected = m.id === selectedModelId
										return (
											<ModelRow
												isSelected={isSelected}
												key={m.id}
												onClick={() => handleSelectModel(m.id)}
												role="option">
												<StarIcon isFavorite={isFavorite} onClick={(e) => toggleFavorite(e, m.id)} />
												<ModelName title={m.id}>{m.name}</ModelName>
											</ModelRow>
										)
									})}
								</>
							)}
							{filteredFavorites.length === 0 && filteredRest.length === 0 && (
								<EmptyState>No models match &quot;{searchTerm}&quot;</EmptyState>
							)}
						</>
					)}
				</DropdownMenu>
			)}
		</DropdownContainer>
	)
}

export default ConversationModelPicker

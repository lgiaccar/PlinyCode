import { ROUTER_TUNING_MAX_MODELS, type RouterModelOption } from "@shared/router-tuning"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { INPUT_CLASS, INPUT_STYLE } from "./RouterFields"

function contextLabel(tokens: number | undefined): string | undefined {
	if (!tokens) {
		return undefined
	}
	return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`
}

function move<T>(list: T[], from: number, to: number): T[] {
	const next = [...list]
	const [item] = next.splice(from, 1)
	next.splice(to, 0, item)
	return next
}

/**
 * An ordered model list: the first model is tried first, the rest are its
 * backups in order. Rows move with their arrow buttons.
 */
export function RouterModelList({
	label,
	models,
	candidates,
	onChange,
}: {
	label: string
	models: string[]
	candidates: RouterModelOption[]
	onChange: (models: string[]) => void
}) {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
	const addable = candidates.filter((candidate) => !models.includes(candidate.id))
	const full = models.length >= ROUTER_TUNING_MAX_MODELS

	const moveTo = (from: number, to: number) => {
		if (to < 0 || to >= models.length) {
			return
		}
		onChange(move(models, from, to))
	}

	return (
		<div className="flex flex-col gap-1">
			<ol aria-label={label} className="m-0 p-0 list-none flex flex-col gap-0.5">
				{models.map((id, index) => {
					const model = byId.get(id)
					const name = model?.name ?? id
					const context = contextLabel(model?.contextWindow)
					return (
						<li
							aria-label={`${index + 1}. ${name}`}
							className="flex items-center gap-1.5 px-1 py-0.5 rounded-xs hover:bg-(--vscode-list-hoverBackground)"
							key={id}>
							<span className="w-4 text-right text-xs text-description">{index + 1}</span>
							<span className="flex-1 min-w-0 truncate" title={id}>
								{name}
								{!model && <span className="text-xs text-(--vscode-errorForeground)"> · not in the catalog</span>}
							</span>
							{context && <span className="text-xs text-description">{context}</span>}
							{model && !model.free && (
								<span className="text-xs px-1 rounded bg-(--vscode-badge-background) text-(--vscode-badge-foreground)">
									paid
								</span>
							)}
							<Button
								aria-label={`Move ${name} up`}
								disabled={index === 0}
								onClick={() => moveTo(index, index - 1)}
								size="icon"
								variant="ghost">
								<ChevronUp />
							</Button>
							<Button
								aria-label={`Move ${name} down`}
								disabled={index === models.length - 1}
								onClick={() => moveTo(index, index + 1)}
								size="icon"
								variant="ghost">
								<ChevronDown />
							</Button>
							<Button
								aria-label={`Remove ${name}`}
								disabled={models.length === 1}
								onClick={() => onChange(models.filter((other) => other !== id))}
								size="icon"
								variant="ghost">
								<X />
							</Button>
						</li>
					)
				})}
			</ol>
			<select
				aria-label={`Add a model to ${label}`}
				className={`${INPUT_CLASS} self-start`}
				disabled={full || addable.length === 0}
				onChange={(event) => {
					if (event.target.value) {
						onChange([...models, event.target.value])
					}
				}}
				style={INPUT_STYLE}
				value="">
				<option value="">{full ? `At most ${ROUTER_TUNING_MAX_MODELS} models` : "Add a model…"}</option>
				{addable.map((candidate) => (
					<option key={candidate.id} value={candidate.id}>
						{candidate.name}
						{candidate.free ? "" : " (paid)"}
						{candidate.name === candidate.id ? "" : ` · ${candidate.id}`}
					</option>
				))}
			</select>
		</div>
	)
}

import { plinyRouterRulesUri } from "@shared/pliny"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { SetRouterTuningRequest } from "@shared/proto/cline/models"
import {
	compactionSizeTokens,
	ROUTER_MAIN_ROUTES,
	type RouterProfileTuning,
	type RouterProfileView,
	type RouterRouteTuning,
	type RouterRouteView,
	type RouterSettingsView,
	type RouterTuningProfile,
	routerCompactionNotes,
} from "@shared/router-tuning"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient, ModelsServiceClient } from "@/services/grpc-client"
import { CompactionSizeField } from "../router/CompactionSizeField"
import { NumberField, SelectField, ToggleField } from "../router/RouterFields"
import { RouterModelList } from "../router/RouterModelList"
import Section from "../Section"

const PROFILE_NAMES: Record<RouterTuningProfile, string> = {
	fast: "FreeAuto Fast",
	default: "FreeAuto",
	smart: "FreeAuto Smart",
	balance: "BalanceAuto",
}

const ROUTE_DESCRIPTIONS: Record<string, string> = {
	"huge-context": "Requests above the size threshold: only the 512k models hold them.",
	subagent: "Calls made by spawned sub-agents.",
	"plan-and-reasoning": "Plan mode.",
	"ask-reasoning": "Ask mode, when the question asks for reasoning.",
	coding: "Act mode, when the request is about code.",
	quick: "Short questions on a short conversation.",
	default: "Everything else, including long multi-step tasks.",
}

const MAIN_ROUTES: ReadonlySet<string> = new Set(ROUTER_MAIN_ROUTES)

function parseView(json: string): RouterSettingsView | undefined {
	try {
		const view = JSON.parse(json) as RouterSettingsView
		return Array.isArray(view?.profiles) ? view : undefined
	} catch {
		return undefined
	}
}

/** A copy of `value` with `key` set, or removed when `next` is undefined; undefined when nothing is left. */
function withField<T extends object, K extends keyof T>(value: T | undefined, key: K, next: T[K] | undefined): T | undefined {
	const copy = { ...(value ?? {}) } as T
	if (next === undefined) {
		delete copy[key]
	} else {
		copy[key] = next
	}
	return Object.keys(copy).length > 0 ? copy : undefined
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div>
			<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mt-4 mb-1">{title}</div>
			<div className="relative px-3 py-1.5 rounded-md border border-editor-widget-border/50">{children}</div>
		</div>
	)
}

function RouteEditor({
	route,
	view,
	onChange,
}: {
	route: RouterRouteView
	view: RouterProfileView
	onChange: (override: RouterRouteTuning | undefined) => void
}) {
	const override = view.tuning.routes?.[route.name]
	const followsOrder = MAIN_ROUTES.has(route.name) && view.tuning.models !== undefined
	const models = override?.use ?? (followsOrder ? (view.tuning.models ?? route.use) : route.use)
	const effort = override?.effort === "default" ? undefined : (override?.effort ?? route.effort)
	const set = <K extends keyof RouterRouteTuning>(key: K, value: RouterRouteTuning[K] | undefined) =>
		onChange(withField(override, key, value))
	return (
		<div className="py-2 border-b border-editor-widget-border/30 last:border-b-0" data-testid={`route-${route.name}`}>
			<div className="flex items-center justify-between gap-2">
				<div>
					<code>{route.name}</code>
					{override && <span className="ml-1 text-(--vscode-textLink-foreground)">●</span>}
				</div>
				{override && (
					<Button onClick={() => onChange(undefined)} size="xs" variant="ghost">
						Reset route
					</Button>
				)}
			</div>
			<div className="text-xs text-description mb-1">
				{ROUTE_DESCRIPTIONS[route.name] ?? "A route from the rules file."}
				{!override?.use && followsOrder ? " Follows the model order above." : ""}
			</div>
			<RouterModelList
				candidates={view.candidates}
				label={`${route.name} models`}
				models={models}
				onChange={(use) => set("use", use)}
			/>
			<SelectField
				fallbackLabel={`Rules file (${route.effort ?? "model default"})`}
				label="Reasoning"
				onCommit={(value) => set("effort", value as RouterRouteTuning["effort"])}
				options={[
					{ value: "quick", label: "Quick: reasoning off" },
					{ value: "think", label: "Think: reasoning on" },
					{ value: "default", label: "Each model's default" },
				]}
				value={override?.effort}
			/>
			{effort === "think" && (
				<SelectField
					fallbackLabel={`Rules file (${route.reasoningEffort ?? "medium"})`}
					label="Reasoning effort"
					onCommit={(value) => set("reasoningEffort", value as RouterRouteTuning["reasoningEffort"])}
					options={[
						{ value: "low", label: "Low" },
						{ value: "medium", label: "Medium" },
						{ value: "high", label: "High" },
					]}
					value={override?.reasoningEffort}
				/>
			)}
			{route.minEstimatedTokens !== undefined && (
				<NumberField
					description="The route applies from this request size up."
					fallback={route.minEstimatedTokens}
					label="From (tokens)"
					onCommit={(value) => set("minEstimatedTokens", value)}
					value={override?.minEstimatedTokens}
				/>
			)}
			{route.maxEstimatedTokens !== undefined && (
				<NumberField
					description="The route applies up to this request size."
					fallback={route.maxEstimatedTokens}
					label="Up to (tokens)"
					onCommit={(value) => set("maxEstimatedTokens", value)}
					value={override?.maxEstimatedTokens}
				/>
			)}
			{route.maxPromptChars !== undefined && (
				<NumberField
					description="The route applies only when your message is at most this long."
					fallback={route.maxPromptChars}
					label="Message up to (characters)"
					onCommit={(value) => set("maxPromptChars", value)}
					value={override?.maxPromptChars}
				/>
			)}
		</div>
	)
}

function ProfileEditor({
	view,
	threshold,
	onChange,
}: {
	view: RouterProfileView
	/** plinycode.compaction.threshold: the share of the budget at which compaction starts. */
	threshold: number
	onChange: (tuning: RouterProfileTuning) => void
}) {
	const { base, tuning } = view
	const [advanced, setAdvanced] = useState(false)
	const customized = Object.keys(tuning).length > 0
	const models = tuning.models ?? base.models
	const update = <K extends keyof RouterProfileTuning>(key: K, value: RouterProfileTuning[K] | undefined) =>
		onChange(withField(tuning, key, value) ?? {})
	const section = <K extends "classifier" | "guard" | "health" | "escalation" | "utility">(key: K) => ({
		value: tuning[key] as Record<string, unknown> | undefined,
		set: (field: string, value: unknown) =>
			update(key, withField(tuning[key] as Record<string, unknown> | undefined, field, value) as RouterProfileTuning[K]),
	})
	const health = section("health")
	const escalation = section("escalation")
	const guard = section("guard")
	const classifier = section("classifier")
	const utility = section("utility")
	const modelOptions = view.candidates.map((candidate) => ({ value: candidate.id, label: candidate.name }))
	const modelName = (id: string) => view.candidates.find((candidate) => candidate.id === id)?.name ?? id
	const budgetTokens = compactionSizeTokens(tuning.compaction?.budget, view.compactionBudget) ?? view.compactionBudget

	return (
		<div className="flex flex-col" data-testid={`router-profile-${view.profile}`}>
			<div className="flex items-center justify-between gap-2 mt-3">
				<div className="font-medium">
					Model order
					{customized && (
						<span className="ml-2 text-xs px-1.5 rounded bg-(--vscode-badge-background) text-(--vscode-badge-foreground)">
							Customized
						</span>
					)}
				</div>
				<Button disabled={!customized} onClick={() => onChange({})} size="xs" variant="secondary">
					Reset to rules file
				</Button>
			</div>
			<p className="text-xs text-description mt-1 mb-2">
				The first model is tried first; the others take over, in order, when it fails or the request does not fit. This
				order leads plan, ask, coding and the catch-all route, and the rest of the catalog stays available as a last
				resort. Four or five models is usually enough.
			</p>
			<RouterModelList
				candidates={view.candidates}
				label="Model order"
				models={models}
				onChange={(next) => update("models", next)}
			/>
			<ToggleField
				description="Never fall back to models outside this list (and the routes' own lists below). Off: when all of them fail, the rest of the catalog is tried."
				fallback={false}
				label="Use only these models"
				onCommit={(value) => {
					// Exclusive needs a stored order: turning it on pins the one shown.
					const next = withField(tuning, "exclusive", value) ?? {}
					onChange(value ? { ...next, models: tuning.models ?? models } : next)
				}}
				value={tuning.exclusive}
			/>

			<Group title="Compaction">
				<CompactionSizeField
					base={view.compactionBudget}
					description={`The conversation is summarized when a request reaches ${Math.round(threshold * 100)}% of this budget (the auto-compact threshold). In % it is a share of ${view.label}'s default, ${view.compactionBudget.toLocaleString("en-US")} tokens.`}
					fallbackTokens={view.compactionBudget}
					label="Compaction budget"
					notes={(tokens) =>
						routerCompactionNotes({
							budgetTokens: tokens ?? view.compactionBudget,
							threshold,
							margin: tuning.contextMarginRatio ?? base.contextMarginRatio,
							models: models.map(
								(id) => view.candidates.find((candidate) => candidate.id === id) ?? { name: modelName(id) },
							),
						})
					}
					onCommit={(value) => update("compaction", withField(tuning.compaction, "budget", value))}
					value={tuning.compaction?.budget}
				/>
				<CompactionSizeField
					base={budgetTokens}
					description="The size a compaction shrinks the conversation to. In % it is a share of the budget. Empty: about 70% of the trigger, or half the budget in a long conversation."
					label="Size after compaction"
					notes={(tokens) =>
						tokens === undefined
							? []
							: routerCompactionNotes({
									budgetTokens,
									targetTokens: tokens,
									threshold,
									margin: tuning.contextMarginRatio ?? base.contextMarginRatio,
									models: [],
								})
					}
					onCommit={(value) => update("compaction", withField(tuning.compaction, "target", value))}
					value={tuning.compaction?.target}
				/>
			</Group>

			<button
				aria-expanded={advanced}
				className="flex items-center gap-1 mt-3 p-0 bg-transparent border-0 text-left cursor-pointer text-(--vscode-textLink-foreground)"
				onClick={() => setAdvanced((open) => !open)}
				type="button">
				<span className={cn("codicon", advanced ? "codicon-chevron-down" : "codicon-chevron-right")} />
				Advanced
			</button>
			{advanced && (
				<div className="flex flex-col">
					<Group title="Routes">
						<p className="text-xs text-description mt-1">
							The first route whose conditions match a request picks its models
							{base.classifier.enabled ? "; with the classifier on, its verdict picks the route" : ""}.
						</p>
						{base.routes.map((route) => (
							<RouteEditor
								key={route.name}
								onChange={(override) => update("routes", withField(tuning.routes, route.name, override))}
								route={route}
								view={view}
							/>
						))}
					</Group>
					<Group title="Classifier and judge">
						<ToggleField
							description="A small model reads your message once per turn and picks the route and whether to think. Adds a short delay to each turn."
							fallback={base.classifier.enabled}
							label="Classifier"
							onCommit={(value) => classifier.set("enabled", value)}
							value={classifier.value?.enabled as boolean | undefined}
						/>
						<NumberField
							fallback={base.classifier.timeoutMs}
							label="Classifier timeout (s)"
							onCommit={(value) => classifier.set("timeoutMs", value)}
							scale={1000}
							value={classifier.value?.timeoutMs as number | undefined}
						/>
						<ToggleField
							description="Before a run ends on a reply with no tool call, a small model is asked whether the task is done."
							fallback={base.guard.judge}
							label="Completion judge"
							onCommit={(value) => guard.set("judge", value)}
							value={guard.value?.judge as boolean | undefined}
						/>
						<NumberField
							fallback={base.guard.judgeTimeoutMs}
							label="Judge timeout (s)"
							onCommit={(value) => guard.set("judgeTimeoutMs", value)}
							scale={1000}
							value={guard.value?.judgeTimeoutMs as number | undefined}
						/>
					</Group>
					<Group title="Failover">
						<NumberField
							description="No output at all for this long fails the call over to the next model."
							fallback={base.health.firstTokenTimeoutMs}
							label="First-token timeout (s)"
							onCommit={(value) => health.set("firstTokenTimeoutMs", value)}
							scale={1000}
							value={health.value?.firstTokenTimeoutMs as number | undefined}
						/>
						<NumberField
							description="A reply that stops producing for this long fails over."
							fallback={base.health.stallTimeoutMs}
							label="Stall timeout (s)"
							onCommit={(value) => health.set("stallTimeoutMs", value)}
							scale={1000}
							value={health.value?.stallTimeoutMs as number | undefined}
						/>
						<NumberField
							fallback={base.health.failuresBeforeCooldown}
							label="Failures before a model is benched"
							onCommit={(value) => health.set("failuresBeforeCooldown", value)}
							value={health.value?.failuresBeforeCooldown as number | undefined}
						/>
						<NumberField
							fallback={base.health.cooldownMs}
							label="Bench time (min)"
							onCommit={(value) => health.set("cooldownMs", value)}
							scale={60_000}
							value={health.value?.cooldownMs as number | undefined}
						/>
						<NumberField
							fallback={base.health.maxFailoversPerTurn}
							label="Failovers per turn"
							onCommit={(value) => health.set("maxFailoversPerTurn", value)}
							value={health.value?.maxFailoversPerTurn as number | undefined}
						/>
					</Group>
					<Group title="Stalls and escalation">
						<NumberField
							description="Reminders sent when a model stops before the task is done (0 sends none)."
							fallback={base.escalation.maxNudgesPerRun}
							label="Reminders per run"
							min={0}
							onCommit={(value) => escalation.set("maxNudgesPerRun", value)}
							value={escalation.value?.maxNudgesPerRun as number | undefined}
						/>
						<NumberField
							description="Stalls in one run before the reminder gets firmer and the turn moves to a stronger model."
							fallback={base.escalation.afterStalls}
							label="Stalls before escalating"
							onCommit={(value) => escalation.set("afterStalls", value)}
							value={escalation.value?.afterStalls as number | undefined}
						/>
						<NumberField
							description="Failed commands in one turn before it moves to the catch-all route's first model."
							fallback={base.escalation.afterFailedCommands}
							label="Failed commands before escalating"
							onCommit={(value) => escalation.set("afterFailedCommands", value)}
							value={escalation.value?.afterFailedCommands as number | undefined}
						/>
						<ToggleField
							description="Keep the model a turn started on for the rest of it, while it stays healthy."
							fallback={base.sticky}
							label="Sticky model per turn"
							onCommit={(value) => update("sticky", value)}
							value={tuning.sticky}
						/>
						<NumberField
							description="Safety factor on the request size when checking that it fits a model's context window."
							fallback={base.contextMarginRatio}
							integer={false}
							label="Context margin"
							onCommit={(value) => update("contextMarginRatio", value)}
							value={tuning.contextMarginRatio}
						/>
					</Group>
					<Group title="Background models">
						{(
							[
								["classifier", "Classifier"],
								["judge", "Completion judge"],
								["summarizer", "Conversation summaries"],
								["commit", "Commit messages"],
							] as const
						).map(([key, label]) => (
							<SelectField
								fallbackLabel={`Rules file (${modelName(base.utility[key])})`}
								key={key}
								label={label}
								onCommit={(value) => utility.set(key, value)}
								options={modelOptions}
								value={utility.value?.[key] as string | undefined}
							/>
						))}
					</Group>
				</div>
			)}

			<p className="text-xs text-description mt-4">
				These settings apply from the next model call, in every conversation on <code>{view.label}</code>, and override
				its rules file field by field.{" "}
				<VSCodeLink
					className="inline text-inherit"
					href="#"
					onClick={(event: React.MouseEvent) => {
						event.preventDefault()
						FileServiceClient.openFile(StringRequest.create({ value: plinyRouterRulesUri(view.profile) })).catch(
							(error) => console.error("Failed to open the routing rules file:", error),
						)
					}}>
					Open rules file
				</VSCodeLink>
			</p>
		</div>
	)
}

/**
 * Settings → Router: per router profile, the model order and every routing
 * knob, laid over the profile's rules file (docs/router-settings.md).
 */
const RouterSettingsSection = ({ renderSectionHeader }: { renderSectionHeader: (tabId: string) => ReactNode }) => {
	const { compactionThreshold } = useExtensionState()
	const [view, setView] = useState<RouterSettingsView>()
	const [selected, setSelected] = useState<RouterTuningProfile>("default")
	const [error, setError] = useState<string>()

	useEffect(() => {
		ModelsServiceClient.getRouterSettings(EmptyRequest.create({}))
			.then((response) => setView(parseView(response.settingsJson)))
			.catch((err) => setError(`Could not load the router settings: ${err instanceof Error ? err.message : String(err)}`))
	}, [])

	const save = (profile: RouterTuningProfile, tuning: RouterProfileTuning) => {
		// Show the change at once; the reply carries what was actually stored.
		setView(
			(current) =>
				current && {
					profiles: current.profiles.map((entry) => (entry.profile === profile ? { ...entry, tuning } : entry)),
				},
		)
		ModelsServiceClient.setRouterTuning(SetRouterTuningRequest.create({ profile, tuningJson: JSON.stringify(tuning) }))
			.then((response) => {
				setError(undefined)
				setView(parseView(response.settingsJson))
			})
			.catch((err) => setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`))
	}

	const profile = view?.profiles.find((entry) => entry.profile === selected)

	return (
		<div>
			{renderSectionHeader("router")}
			<Section>
				<p className="text-sm text-description m-0">
					Choose which models each router uses, in order, and tune how it fails over. Changes take effect on the next
					request, with no restart.
				</p>
				<div className="flex flex-wrap gap-1" role="tablist">
					{(view?.profiles ?? []).map((entry) => (
						<Button
							aria-selected={entry.profile === selected}
							key={entry.profile}
							onClick={() => setSelected(entry.profile)}
							role="tab"
							size="sm"
							title={entry.label}
							variant={entry.profile === selected ? "default" : "secondary"}>
							{PROFILE_NAMES[entry.profile]}
							{Object.keys(entry.tuning).length > 0 ? " ●" : ""}
						</Button>
					))}
				</div>
				{error && <div className="text-error text-xs">{error}</div>}
				{!view && !error && <div className="text-xs text-description">Loading…</div>}
				{profile && (
					<ProfileEditor
						key={profile.profile}
						onChange={(tuning) => save(profile.profile, tuning)}
						threshold={compactionThreshold ?? 0.9}
						view={profile}
					/>
				)}
			</Section>
		</div>
	)
}

export default RouterSettingsSection

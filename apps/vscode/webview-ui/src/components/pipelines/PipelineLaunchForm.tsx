import type { CiRepo } from "@shared/proto/cline/ci_board"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import {
	type PipelineDefinitionInfo,
	type PipelineInputSchema,
	PipelineSelection,
	QueuePipelineRequest,
} from "@shared/proto/cline/pipeline"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { CiBoardServiceClient, PipelineServiceClient, UiServiceClient } from "@/services/grpc-client"

export const fieldClass =
	"w-full min-w-0 bg-input-background text-input-foreground border border-input-border rounded px-2 py-1.5 text-sm"
export const pipelineError = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function PipelineLaunchForm() {
	const [repos, setRepos] = useState<CiRepo[]>([])
	const [repoRoot, setRepoRoot] = useState("")
	const [pipelines, setPipelines] = useState<PipelineDefinitionInfo[]>([])
	const [pipelineId, setPipelineId] = useState(0)
	const [ref, setRef] = useState("")
	const [schema, setSchema] = useState<PipelineInputSchema>()
	const [values, setValues] = useState<Record<string, string>>({})
	const [loading, setLoading] = useState(true)
	const [loadingInputs, setLoadingInputs] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const [notice, setNotice] = useState("")
	const [revision, setRevision] = useState(0)
	const launch = useRef<{ id: string; fingerprint: string }>()
	const submitting = useRef(false)

	useEffect(() => {
		let cancelled = false
		CiBoardServiceClient.listCiRepos(EmptyRequest.create({}))
			.then(({ repos: available }) => {
				if (cancelled) return
				setRepos(available)
				setRepoRoot(available[0]?.root ?? "")
				setRef(available[0]?.currentBranch ?? "")
			})
			.catch((failure) => {
				if (!cancelled) setError(pipelineError(failure))
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [])

	useEffect(() => {
		if (!repoRoot) return
		let cancelled = false
		setLoading(true)
		setPipelines([])
		setPipelineId(0)
		setSchema(undefined)
		setError("")
		PipelineServiceClient.listPipelines(StringRequest.create({ value: repoRoot }))
			.then((list) => {
				if (cancelled) return
				setPipelines(list.pipelines)
				setPipelineId(list.pipelines[0]?.id ?? 0)
				setRef((current) => current || list.defaultRef)
			})
			.catch((failure) => {
				if (!cancelled) setError(pipelineError(failure))
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [repoRoot])

	useEffect(() => {
		setSchema(undefined)
		setNotice("")
		if (!repoRoot || !pipelineId || !ref.trim()) {
			setLoadingInputs(false)
			return
		}
		let cancelled = false
		setLoadingInputs(true)
		const timer = setTimeout(() => {
			PipelineServiceClient.getPipelineInputs(PipelineSelection.create({ repoRoot, pipelineId, ref: ref.trim() }))
				.then((next) => {
					if (cancelled) return
					setSchema(next)
					setValues(
						Object.fromEntries(
							next.parameters.map((parameter) => {
								const value = parameter.defaultJson ? JSON.parse(parameter.defaultJson) : undefined
								return [
									parameter.name,
									parameter.type === "choice" || parameter.type === "object"
										? parameter.defaultJson
										: value === undefined
											? parameter.type === "boolean" && parameter.required
												? "false"
												: ""
											: String(value),
								]
							}),
						),
					)
					setError("")
				})
				.catch((failure) => {
					if (!cancelled) setError(pipelineError(failure))
				})
				.finally(() => {
					if (!cancelled) setLoadingInputs(false)
				})
		}, 250)
		return () => {
			cancelled = true
			clearTimeout(timer)
		}
	}, [repoRoot, pipelineId, ref, revision])

	const run = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!schema || submitting.current) return
		submitting.current = true
		setBusy(true)
		setError("")
		setNotice("")
		try {
			const inputs: Record<string, unknown> = {}
			for (const parameter of schema.parameters) {
				const value = values[parameter.name] ?? ""
				if (value === "" && !parameter.required) continue
				if (value === "" && parameter.required) throw new Error(`${parameter.label} is required.`)
				if (["object", "choice"].includes(parameter.type)) {
					try {
						inputs[parameter.name] = JSON.parse(value)
					} catch {
						throw new Error(`${parameter.label} must be valid JSON.`)
					}
				} else if (parameter.type === "number") {
					const number = Number(value)
					if (!Number.isFinite(number)) throw new Error(`${parameter.label} must be a number.`)
					inputs[parameter.name] = number
				} else inputs[parameter.name] = parameter.type === "boolean" ? value === "true" : value
			}
			const selection = {
				repoRoot,
				pipelineId,
				ref: ref.trim(),
				revision: schema.revision,
				inputsJson: JSON.stringify(inputs),
			}
			const fingerprint = JSON.stringify(selection)
			if (launch.current?.fingerprint !== fingerprint) launch.current = { fingerprint, id: crypto.randomUUID() }
			await PipelineServiceClient.queuePipelineRun(QueuePipelineRequest.create({ ...selection, id: launch.current.id }))
			launch.current = undefined
			setNotice("Launch recorded.")
		} catch (failure) {
			setError(pipelineError(failure))
		} finally {
			submitting.current = false
			setBusy(false)
		}
	}

	const selectedPipeline = pipelines.find((pipeline) => pipeline.id === pipelineId)
	return (
		<form className="flex flex-col gap-3 pb-4 border-b border-panel-border" onSubmit={run}>
			<fieldset className="flex flex-col gap-3 border-0 m-0 p-0 min-w-0" disabled={busy}>
				<label className="flex flex-col gap-1 text-xs">
					Repository
					<select
						className={fieldClass}
						onChange={(event) => {
							setRepoRoot(event.target.value)
							setRef(repos.find((repo) => repo.root === event.target.value)?.currentBranch ?? "")
							setSchema(undefined)
						}}
						value={repoRoot}>
						<option disabled value="">
							Select repository
						</option>
						{repos.map((repo) => (
							<option key={repo.root} value={repo.root}>
								{repo.root}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-xs">
					Pipeline
					<select
						className={fieldClass}
						disabled={loading}
						onChange={(event) => {
							setPipelineId(Number(event.target.value))
							setSchema(undefined)
						}}
						value={pipelineId}>
						<option disabled value={0}>
							Select pipeline
						</option>
						{pipelines.map((pipeline) => (
							<option key={pipeline.id} value={pipeline.id}>
								{pipeline.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-xs">
					Branch or ref
					<input
						className={fieldClass}
						onChange={(event) => {
							setRef(event.target.value)
							setSchema(undefined)
						}}
						required
						value={ref}
					/>
				</label>
				{loading || loadingInputs ? (
					<div className="text-sm text-description" role="status">
						Loading...
					</div>
				) : !repos.length ? (
					<div className="text-sm text-description">No connected GitHub or Azure DevOps repositories.</div>
				) : !pipelines.length ? (
					<div className="text-sm text-description">No runnable pipelines found.</div>
				) : null}
				{schema?.parameters.map((parameter) => {
					const id = `pipeline-input-${parameter.name}`
					const value = values[parameter.name] ?? ""
					const change = (next: string) => setValues((current) => ({ ...current, [parameter.name]: next }))
					return (
						<div className="flex flex-col gap-1 min-w-0" key={parameter.name}>
							<label className="text-xs break-words" htmlFor={id}>
								{parameter.label}
								{parameter.required ? " *" : ""}
							</label>
							{parameter.type === "boolean" ? (
								<input
									checked={value === "true"}
									className="self-start accent-[var(--vscode-focusBorder)]"
									id={id}
									onChange={(event) => change(String(event.target.checked))}
									type="checkbox"
								/>
							) : parameter.type === "choice" ? (
								<select
									className={fieldClass}
									id={id}
									onChange={(event) => change(event.target.value)}
									required={parameter.required}
									value={value}>
									<option value="">{parameter.required ? "Select value" : "Default"}</option>
									{parameter.optionsJson.map((option) => (
										<option key={option} value={option}>
											{String(JSON.parse(option))}
										</option>
									))}
								</select>
							) : parameter.type === "object" ? (
								<textarea
									className={`${fieldClass} font-mono resize-y`}
									id={id}
									onChange={(event) => change(event.target.value)}
									required={parameter.required}
									rows={4}
									value={value}
								/>
							) : (
								<input
									className={fieldClass}
									id={id}
									onChange={(event) => change(event.target.value)}
									required={parameter.required}
									step={parameter.type === "number" ? "any" : undefined}
									type={parameter.type === "number" ? "number" : "text"}
									value={value}
								/>
							)}
						</div>
					)
				})}
				{schema?.limitations.map((limitation) => (
					<div className="text-sm text-warning break-words" key={limitation}>
						{limitation}
					</div>
				))}
				<div className="flex items-center gap-2 flex-wrap">
					<Button disabled={!schema || loadingInputs || !!schema.limitations.length || busy} size="sm" type="submit">
						<span
							aria-hidden="true"
							className={`codicon ${busy ? "codicon-loading codicon-modifier-spin" : "codicon-play"}`}
						/>{" "}
						{busy ? "Queueing..." : "Run"}
					</Button>
					<Button
						aria-label="Reload pipeline parameters"
						className="h-7 w-7 shrink-0"
						disabled={busy || !pipelineId || !ref.trim()}
						onClick={() => setRevision((current) => current + 1)}
						size="icon"
						title="Reload pipeline parameters"
						type="button"
						variant="ghost">
						<span aria-hidden="true" className="codicon codicon-refresh" />
					</Button>
					{selectedPipeline && (
						<Button
							aria-label="Open pipeline in provider"
							className="h-7 w-7 shrink-0"
							onClick={() =>
								UiServiceClient.openUrl(StringRequest.create({ value: selectedPipeline.url })).catch((failure) =>
									setError(pipelineError(failure)),
								)
							}
							size="icon"
							title="Open pipeline in provider"
							type="button"
							variant="ghost">
							<span aria-hidden="true" className="codicon codicon-link-external" />
						</Button>
					)}
				</div>
			</fieldset>
			{error && (
				<div className="text-sm text-error break-words" role="alert">
					{error}
				</div>
			)}
			{notice && (
				<div className="text-sm text-description" role="status">
					{notice}
				</div>
			)}
		</form>
	)
}

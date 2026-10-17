/**
 * A launch the agent asks for (`pipeline_run`): which pipeline it names, and its inputs checked against the
 * pipeline's YAML at the ref, with the same validation the Pipelines view's form goes through. Shared by the
 * server process and the extension host, so no `vscode` import.
 */
import { DevOpsError } from "../server/errors"
import type { PipelineDefinition, PipelineProvider } from "../server/providers/types"
import { type PipelineInput, type PipelineSchema, validatePipelineInputs } from "./pipeline-inputs"

export interface PreparedLaunch {
	pipeline: PipelineDefinition
	ref: string
	schema: PipelineSchema
	/** The inputs as they will be sent, with the model's text values turned into the declared types. */
	inputs: Record<string, unknown>
}

const LISTED_PIPELINES = 30

/** The pipeline `wanted` names: its id, its name (any case) or, on GitHub, its workflow file name. */
function findPipeline(definitions: PipelineDefinition[], wanted: string): PipelineDefinition {
	const key = wanted.trim()
	const lower = key.toLowerCase()
	const byId = /^\d+$/.test(key) ? definitions.filter((d) => d.id === Number(key)) : []
	const byName = definitions.filter((d) => d.name.toLowerCase() === lower)
	// A GitHub workflow's URL ends with its file name (`build.yml`).
	const byFile = definitions.filter((d) => {
		try {
			return decodeURIComponent(d.url.split("/").at(-1) ?? "").toLowerCase() === lower
		} catch {
			return false
		}
	})
	const matches = byId.length ? byId : byName.length ? byName : byFile
	if (matches.length === 1) return matches[0]
	if (matches.length > 1) {
		throw new DevOpsError(
			`Several pipelines are called '${key}' (${matches.map((d) => `id ${d.id}`).join(", ")}); pass the id.`,
		)
	}
	if (!definitions.length) {
		throw new DevOpsError("This repository has no pipeline that can be run manually.")
	}
	const listed = definitions
		.slice(0, LISTED_PIPELINES)
		.map((d) => `${d.name} (id ${d.id})`)
		.join(", ")
	const more = definitions.length > LISTED_PIPELINES ? ", …" : ""
	throw new DevOpsError(`No pipeline '${key}' can be run here. Pipelines: ${listed}${more}.`)
}

function matchOption(input: PipelineInput, value: unknown): unknown {
	const options = input.options ?? []
	return (
		options.find((option) => JSON.stringify(option) === JSON.stringify(value)) ??
		options.find((option) => String(option) === String(value)) ??
		value
	)
}

/** Models write `"true"`, `"3"` or JSON text where the pipeline declares a boolean, a number or an object. */
function coerce(input: PipelineInput, value: unknown): unknown {
	if (input.type === "choice") return matchOption(input, value)
	if (typeof value !== "string") {
		return input.type === "string" && (typeof value === "number" || typeof value === "boolean") ? String(value) : value
	}
	const text = value.trim()
	if (input.type === "boolean" && /^(true|false)$/i.test(text)) return text.toLowerCase() === "true"
	if (input.type === "number" && text !== "" && Number.isFinite(Number(text))) return Number(text)
	if (input.type === "object") {
		try {
			return JSON.parse(text)
		} catch {
			return value
		}
	}
	return value
}

function describeInputs(schema: PipelineSchema): string {
	if (!schema.inputs.length) return "The pipeline takes no inputs."
	const lines = schema.inputs.map((input) => {
		const details: string[] = [input.type]
		if (input.options) details.push(`one of ${input.options.map((option) => JSON.stringify(option)).join(", ")}`)
		if (input.required) details.push("required")
		if (Object.hasOwn(input, "default")) details.push(`default ${JSON.stringify(input.default)}`)
		return `- ${input.name}: ${details.join(", ")}`
	})
	return `The pipeline's inputs:\n${lines.join("\n")}`
}

/** Finds the pipeline, reads its inputs at `ref` and checks the values; nothing is queued. */
export async function preparePipelineLaunch(
	provider: PipelineProvider,
	request: { pipeline: string; ref: string; inputs: Record<string, unknown> },
): Promise<PreparedLaunch> {
	const pipeline = findPipeline(await provider.listPipelines(), request.pipeline)
	const schema = await provider.pipelineInputs(pipeline.id, request.ref)
	const inputs: Record<string, unknown> = {}
	for (const [name, value] of Object.entries(request.inputs)) {
		const input = schema.inputs.find((candidate) => candidate.name === name)
		inputs[name] = input ? coerce(input, value) : value
	}
	try {
		validatePipelineInputs(schema, inputs)
	} catch (error) {
		// A limitation (no manual dispatch, an `extends` template) is not fixed by other values.
		if (error instanceof DevOpsError && !schema.limitations.length) {
			throw new DevOpsError(`${error.message}\n${describeInputs(schema)}`)
		}
		throw error
	}
	return { pipeline, ref: request.ref, schema, inputs }
}

import * as yaml from "js-yaml"
import { DevOpsError } from "../server/errors"

export interface PipelineInput {
	name: string
	label: string
	type: "string" | "boolean" | "number" | "choice" | "object" | "environment"
	required: boolean
	default?: unknown
	options?: unknown[]
}

export interface PipelineSchema {
	revision: string
	inputs: PipelineInput[]
	limitations: string[]
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function parsePipelineInputs(text: string, kind: "github" | "ado", revision: string): PipelineSchema {
	const document = record(yaml.load(text, { schema: yaml.JSON_SCHEMA }))
	const inputs: PipelineInput[] = []
	const limitations: string[] = []
	let entries: [string, unknown][]
	if (kind === "github") {
		const events = document.on
		const dispatch =
			typeof events === "string"
				? events === "workflow_dispatch"
				: Array.isArray(events)
					? events.includes("workflow_dispatch")
					: Object.hasOwn(record(events), "workflow_dispatch")
		if (!dispatch) limitations.push("This workflow does not support manual dispatch on the selected ref.")
		entries = Object.entries(record(record(record(events).workflow_dispatch).inputs))
	} else {
		if (document.extends) limitations.push("Pipelines using extends templates require the Azure DevOps run page.")
		entries = Array.isArray(document.parameters)
			? document.parameters.map((parameter) => [String(record(parameter).name ?? ""), parameter])
			: Object.entries(record(document.parameters)).map(([name, value]) => [name, { default: value, type: typeof value }])
	}
	for (const [name, value] of entries) {
		const data = record(value)
		const declared = String(data.type ?? "string")
		if (!name || !["string", "boolean", "number", "choice", "object", "environment"].includes(declared)) {
			limitations.push(`Unsupported parameter '${name || "(template)"}' of type '${declared}'.`)
			continue
		}
		const options = data.options ?? data.values
		inputs.push({
			name,
			label: String(data.description ?? data.displayName ?? name),
			type: Array.isArray(options) ? "choice" : (declared as PipelineInput["type"]),
			required: kind === "github" ? data.required === true : !Object.hasOwn(data, "default"),
			...(Object.hasOwn(data, "default") ? { default: data.default } : {}),
			...(Array.isArray(options) ? { options } : {}),
		})
	}
	return { revision, inputs, limitations }
}

export function validatePipelineInputs(schema: PipelineSchema, values: Record<string, unknown>): void {
	if (schema.limitations.length) throw new DevOpsError(schema.limitations.join(" "))
	for (const name of Object.keys(values)) {
		if (!schema.inputs.some((input) => input.name === name)) throw new DevOpsError(`Unknown parameter '${name}'.`)
	}
	for (const input of schema.inputs) {
		const value = Object.hasOwn(values, input.name) ? values[input.name] : input.default
		if (value === undefined || (value === "" && input.required)) {
			if (input.required) throw new DevOpsError(`Parameter '${input.name}' is required.`)
			continue
		}
		const valid =
			input.type === "boolean"
				? typeof value === "boolean"
				: input.type === "number"
					? typeof value === "number" && Number.isFinite(value)
					: input.type === "object"
						? value !== null && typeof value === "object"
						: input.type === "choice"
							? input.options?.some((option) => JSON.stringify(option) === JSON.stringify(value))
							: typeof value === "string"
		if (!valid) throw new DevOpsError(`Invalid value for parameter '${input.name}'.`)
	}
}

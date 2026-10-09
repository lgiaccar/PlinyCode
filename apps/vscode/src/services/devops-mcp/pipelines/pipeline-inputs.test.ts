import { describe, expect, it } from "bun:test"
import { parsePipelineInputs, validatePipelineInputs } from "./pipeline-inputs"

describe("pipeline input discovery", () => {
	it("preserves GitHub's on key and false/zero defaults", () => {
		const schema = parsePipelineInputs(
			`on:
  workflow_dispatch:
    inputs:
      enabled: {type: boolean, default: false, required: true}
      count: {type: number, default: 0}
      target: {type: choice, options: [dev, prod], required: true}
`,
			"github",
			"sha",
		)
		expect(schema.limitations).toEqual([])
		expect(schema.inputs.map((input) => input.default)).toEqual([false, 0, undefined])
		expect(() => validatePipelineInputs(schema, { target: "dev" })).not.toThrow()
		expect(() => validatePipelineInputs(schema, { target: "bad" })).toThrow("Invalid value")
		expect(() => validatePipelineInputs(schema, { target: "dev", enabled: "false" })).toThrow("Invalid value")
	})

	it("discovers ADO runtime parameters rather than variables", () => {
		const schema = parsePipelineInputs(
			`parameters:
  - name: config
    type: object
    default: {count: 0}
  - name: target
    type: string
    values: [dev, prod]
variables:
  secret: ignored
`,
			"ado",
			"sha",
		)
		expect(schema.inputs.map((input) => input.name)).toEqual(["config", "target"])
		expect(() => validatePipelineInputs(schema, { target: "prod", config: { count: 2 } })).not.toThrow()
		expect(() => validatePipelineInputs(schema, {})).toThrow("required")
		expect(() => validatePipelineInputs(schema, { target: "prod", secret: "x" })).toThrow("Unknown parameter")
	})

	it("supports dispatch without inputs and rejects unsupported schemas", () => {
		expect(parsePipelineInputs("on: [push, workflow_dispatch]", "github", "sha").limitations).toEqual([])
		expect(parsePipelineInputs("on: push", "github", "sha").limitations).toHaveLength(1)
		const schema = parsePipelineInputs("parameters:\n  - name: steps\n    type: stepList", "ado", "sha")
		expect(() => validatePipelineInputs(schema, {})).toThrow("Unsupported parameter")
		expect(parsePipelineInputs("extends: {template: other.yml}", "ado", "sha").limitations).toHaveLength(1)
	})
})

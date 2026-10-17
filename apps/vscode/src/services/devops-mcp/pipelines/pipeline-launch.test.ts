import { describe, expect, it } from "bun:test"
import type { PipelineDefinition, PipelineProvider } from "../server/providers/types"
import type { PipelineSchema } from "./pipeline-inputs"
import { preparePipelineLaunch } from "./pipeline-launch"

const provider = (definitions: PipelineDefinition[], schema: PipelineSchema) => {
	const asked: [number, string][] = []
	const fake = {
		listPipelines: async () => definitions,
		pipelineInputs: async (id: number, ref: string) => {
			asked.push([id, ref])
			return schema
		},
	} as unknown as PipelineProvider
	return { fake, asked }
}

const schema: PipelineSchema = {
	revision: "r",
	limitations: [],
	inputs: [
		{ name: "flag", label: "flag", type: "boolean", required: false, default: false },
		{ name: "size", label: "size", type: "number", required: false },
		{ name: "level", label: "level", type: "choice", required: true, options: [1, 2] },
		{ name: "config", label: "config", type: "object", required: false },
		{ name: "note", label: "note", type: "string", required: false },
	],
}

const build = { id: 4, name: "Build", url: "https://dev.azure.com/o/p/_build?definitionId=4" }

describe("preparePipelineLaunch", () => {
	it("turns the model's text values into the declared types", async () => {
		const { fake, asked } = provider([build], schema)
		const prepared = await preparePipelineLaunch(fake, {
			pipeline: "build",
			ref: "refs/tags/v1",
			inputs: { flag: "TRUE", size: " 3 ", level: "2", config: '{"a":[1]}', note: 5 },
		})
		expect(asked).toEqual([[4, "refs/tags/v1"]])
		expect(prepared.inputs).toEqual({ flag: true, size: 3, level: 2, config: { a: [1] }, note: "5" })
		expect(prepared.pipeline).toBe(build)
	})

	it("picks a pipeline by id before name, and asks for the id when names collide", async () => {
		const twins = [
			{ id: 7, name: "Deploy", url: "" },
			{ id: 8, name: "deploy", url: "" },
			{ id: 9, name: "7", url: "" },
		]
		const { fake } = provider(twins, { ...schema, inputs: [] })
		expect((await preparePipelineLaunch(fake, { pipeline: "7", ref: "main", inputs: {} })).pipeline.id).toBe(7)
		await expect(preparePipelineLaunch(fake, { pipeline: "Deploy", ref: "main", inputs: {} })).rejects.toThrow(
			"Several pipelines are called 'Deploy' (id 7, id 8); pass the id.",
		)
		const { fake: none } = provider([], schema)
		await expect(preparePipelineLaunch(none, { pipeline: "x", ref: "main", inputs: {} })).rejects.toThrow(
			"This repository has no pipeline that can be run manually.",
		)
	})

	it("lists the inputs when a value or name is wrong, but not for a pipeline that cannot be queued at all", async () => {
		const { fake } = provider([build], schema)
		await expect(
			preparePipelineLaunch(fake, { pipeline: "4", ref: "main", inputs: { level: 1, colour: "red" } }),
		).rejects.toThrow(
			"Unknown parameter 'colour'.\nThe pipeline's inputs:\n- flag: boolean, default false\n- size: number\n- level: choice, one of 1, 2, required",
		)
		await expect(
			preparePipelineLaunch(fake, { pipeline: "4", ref: "main", inputs: { level: 1, size: "big" } }),
		).rejects.toThrow("Invalid value for parameter 'size'.")
		const limited = provider([build], {
			...schema,
			limitations: ["Pipelines using extends templates require the Azure DevOps run page."],
		})
		const failure = await preparePipelineLaunch(limited.fake, { pipeline: "4", ref: "main", inputs: {} }).catch(
			(error: Error) => error,
		)
		expect((failure as Error).message).toBe("Pipelines using extends templates require the Azure DevOps run page.")
	})
})

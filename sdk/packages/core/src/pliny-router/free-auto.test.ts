import {
	getModelsForProvider,
	isPlinySelfHostedModelId,
} from "@plinycode/llms";
import type {
	AgentConfig,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
} from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import { createFreeAutoModelFactory } from "./free-auto";

const catalog = await getModelsForProvider("pliny", { filter: "chat" });
const request: AgentModelRequest = {
	messages: [
		{
			id: "u",
			createdAt: 0,
			role: "user",
			content: [{ type: "text", text: "Implement the requested change" }],
		},
	],
	tools: [],
};
const success: AgentModelEvent[] = [
	{ type: "text-delta", text: "Done" },
	{ type: "finish", reason: "stop" },
];
const failure: AgentModelEvent = {
	type: "finish",
	reason: "error",
	error: "model unavailable",
};
async function collect(model: AgentModel, input = request) {
	const events: AgentModelEvent[] = [];
	for await (const event of await model.stream(input)) events.push(event);
	return events;
}
function setup(
	script: (id: string, calls: string[]) => AgentModelEvent[],
	knownModels = catalog,
	excludedModels?: string[],
) {
	const calls: string[] = [];
	const factory = createFreeAutoModelFactory({ knownModels, excludedModels });
	const create = () =>
		factory({
			config: {} as AgentConfig,
			createDefault: ({ modelId } = {}) => ({
				async *stream() {
					if (!modelId) throw new Error("Expected a concrete model.");
					calls.push(modelId);
					for (const event of script(modelId, calls)) yield event;
				},
			}),
		});
	return { calls, create };
}

describe("standalone FreeAuto", () => {
	it("can exclude the model that failed structured-output validation", async () => {
		const { create, calls } = setup(() => success, catalog, [
			"snps-provider/kimi-k2.6",
		]);
		await collect(create());
		expect(calls).toEqual(["snps-provider-vmodels/glm-5.3"]);
	});
	it("uses the shared default order and only free models", async () => {
		const { create, calls } = setup(() => success);
		expect(await collect(create())).toEqual(success);
		expect(calls).toEqual(["snps-provider/kimi-k2.6"]);
		expect(calls.every(isPlinySelfHostedModelId)).toBe(true);
	});
	it("fails over before output and stays on the successful model for this run", async () => {
		const { create, calls } = setup((_id, calls) =>
			calls.length === 1 ? [failure] : success,
		);
		const model = create();
		await collect(model);
		await collect(model);
		expect(calls).toEqual([
			"snps-provider/kimi-k2.6",
			"snps-provider-vmodels/glm-5.3",
			"snps-provider-vmodels/glm-5.3",
		]);
		await collect(create());
		expect(calls.at(-1)).toBe("snps-provider/kimi-k2.6");
	});
	it("bounds failed attempts without paying for a fallback", async () => {
		const { create, calls } = setup(() => [failure]);
		const events = await collect(create());
		expect(calls).toHaveLength(4);
		expect(calls.every(isPlinySelfHostedModelId)).toBe(true);
		expect(events.at(-1)).toMatchObject({
			type: "finish",
			reason: "error",
			errorRetryable: false,
		});
	});
	it("does not fail over for authentication errors", async () => {
		const { create, calls } = setup(() => [
			{
				type: "finish",
				reason: "error",
				error: "401 Unauthorized: invalid API key",
				errorClass: "auth",
			},
		]);
		await collect(create());
		expect(calls).toHaveLength(1);
	});
	it("does not replay partially streamed text or tool calls", async () => {
		for (const partial of [
			{ type: "text-delta", text: "Partial" },
			{
				type: "tool-call-delta",
				toolCallId: "call_1",
				toolName: "editor",
				inputTextDelta: "{}",
			},
		] as AgentModelEvent[]) {
			const { create, calls } = setup(() => [
				partial,
				{ ...failure, errorRetryable: true } as AgentModelEvent,
			]);
			const events = await collect(create());
			expect(calls).toHaveLength(1);
			expect(events.at(-1)).toMatchObject({
				type: "finish",
				reason: "error",
				errorRetryable: false,
			});
		}
	});
	it("makes no request after cancellation or without an eligible model", async () => {
		const controller = new AbortController();
		controller.abort();
		const { create, calls } = setup(() => success);
		expect(
			await collect(create(), { ...request, signal: controller.signal }),
		).toEqual([{ type: "finish", reason: "aborted" }]);
		expect(calls).toHaveLength(0);
		const empty = setup(() => success, {});
		expect((await collect(empty.create())).at(-1)).toMatchObject({
			reason: "error",
		});
		expect(empty.calls).toHaveLength(0);
	});
	it("selects a larger free model when the leading model cannot fit the request", async () => {
		const models = {
			...catalog,
			"snps-provider/kimi-k2.6": {
				...catalog["snps-provider/kimi-k2.6"],
				contextWindow: 1,
			},
		};
		const { create, calls } = setup(() => success, models);
		await collect(create());
		expect(calls[0]).toBe("snps-provider-vmodels/glm-5.3");
	});
});

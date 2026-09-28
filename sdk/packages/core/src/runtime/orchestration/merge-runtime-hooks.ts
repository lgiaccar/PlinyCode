import { type AgentRuntimeHooks, mergeModelOptions } from "@plinycode/shared";

export function mergeRuntimeHooks(
	layers: Array<Partial<AgentRuntimeHooks> | undefined>,
): Partial<AgentRuntimeHooks> {
	const hooks = layers.filter(
		(layer): layer is Partial<AgentRuntimeHooks> => layer !== undefined,
	);
	if (hooks.length === 0) {
		return {};
	}

	return {
		beforeRun: async (ctx) => {
			for (const hook of hooks) {
				const result = await hook.beforeRun?.(ctx);
				if (result?.stop) return result;
			}
			return undefined;
		},
		afterRun: async (ctx) => {
			for (const hook of hooks) {
				await hook.afterRun?.(ctx);
			}
		},
		beforeModel: async (ctx) => {
			let request = ctx.request;
			let aggregate:
				| Awaited<ReturnType<NonNullable<AgentRuntimeHooks["beforeModel"]>>>
				| undefined;
			for (const hook of hooks) {
				const result = await hook.beforeModel?.({ ...ctx, request });
				if (!result) continue;
				if (result.stop) return result;
				aggregate = {
					...aggregate,
					...result,
					options: mergeModelOptions(aggregate?.options, result.options),
				};
				request = {
					...request,
					...(result.messages ? { messages: result.messages } : {}),
					...(result.tools ? { tools: result.tools } : {}),
					...(result.options
						? { options: mergeModelOptions(request.options, result.options) }
						: {}),
				};
			}
			return aggregate;
		},
		afterModel: async (ctx) => {
			for (const hook of hooks) {
				const result = await hook.afterModel?.(ctx);
				if (result?.stop) return result;
			}
			return undefined;
		},
		beforeTool: async (ctx) => {
			let input = ctx.input;
			let aggregate:
				| Awaited<ReturnType<NonNullable<AgentRuntimeHooks["beforeTool"]>>>
				| undefined;
			for (const hook of hooks) {
				const result = await hook.beforeTool?.({ ...ctx, input });
				if (!result) continue;
				if (result.stop || result.skip) return result;
				aggregate = { ...aggregate, ...result };
				if (Object.hasOwn(result, "input")) {
					input = result.input;
				}
			}
			return aggregate;
		},
		afterTool: async (ctx) => {
			let result = ctx.result;
			let aggregate:
				| Awaited<ReturnType<NonNullable<AgentRuntimeHooks["afterTool"]>>>
				| undefined;
			for (const hook of hooks) {
				const next = await hook.afterTool?.({ ...ctx, result });
				if (!next) continue;
				if (next.stop) return next;
				aggregate = { ...aggregate, ...next };
				if (next.result) {
					result = next.result;
				}
			}
			return aggregate;
		},
		onEvent: async (event) => {
			for (const hook of hooks) {
				await hook.onEvent?.(event);
			}
		},
	};
}

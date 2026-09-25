/**
 * Layer the router's own runtime hooks over the ones the session already has
 * (the file-based hook scripts from `hooks-adapter.ts`), so both keep running.
 *
 * Only `afterTool` and `afterRun` are composed — the router observes; it never
 * blocks a tool or a run. The base hook is called first and its answer wins on
 * `stop`/`result`; `appendContext` from both sides is concatenated so a hook
 * script's context and the router's note both reach the model.
 */

import type {
	AgentAfterToolContext,
	AgentAfterToolResult,
	AgentHooks,
	AgentRunLifecycleContext,
	AgentRunResult,
} from "@plinycode/shared"

export interface RouterHooks {
	afterTool?: (context: AgentAfterToolContext) => AgentAfterToolResult | undefined | Promise<AgentAfterToolResult | undefined>
	afterRun?: (context: AgentRunLifecycleContext & { result: AgentRunResult }) => void | Promise<void>
}

function joinContext(first: string | undefined, second: string | undefined): string | undefined {
	const parts = [first, second].map((part) => part?.trim()).filter((part): part is string => Boolean(part))
	return parts.length > 0 ? parts.join("\n\n") : undefined
}

export function composeHooks(base: AgentHooks | undefined, extra: RouterHooks): AgentHooks {
	const composed: AgentHooks = { ...(base ?? {}) }

	if (extra.afterTool) {
		const baseAfterTool = base?.afterTool
		const routerAfterTool = extra.afterTool
		composed.afterTool = async (context) => {
			const baseResult = await baseAfterTool?.(context)
			const routerResult = await routerAfterTool(context)
			if (!routerResult) {
				return baseResult
			}
			const appendContext = joinContext(baseResult?.appendContext, routerResult.appendContext)
			return {
				...routerResult,
				...(baseResult ?? {}),
				...(appendContext ? { appendContext } : {}),
			}
		}
	}

	if (extra.afterRun) {
		const baseAfterRun = base?.afterRun
		const routerAfterRun = extra.afterRun
		composed.afterRun = async (context) => {
			try {
				await baseAfterRun?.(context)
			} finally {
				await routerAfterRun(context)
			}
		}
	}

	return composed
}

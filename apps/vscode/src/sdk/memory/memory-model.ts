// The model call memory distillation makes: one request, no tools, to the
// free utility summarizer the router rules name (a large-context model), so
// distilling costs nothing and needs no spending checks.

import { StateManager } from "@/core/storage/StateManager"
import { loadRouterRules } from "../router/router-rules-store"
import { buildApiHandler } from "../sdk-api-handler"

export async function completeWithUtilityModel(
	system: string,
	user: string,
	signal: AbortSignal,
	workspaceRoot: string,
): Promise<string> {
	const rules = await loadRouterRules({ workspaceRoot })
	const handler = buildApiHandler(StateManager.get().getApiConfiguration(), "act", {
		disableReasoning: true,
		modelId: rules.utility.summarizer,
	})
	handler.setAbortSignal?.(signal)
	let text = ""
	let streamError: string | undefined
	const consume = async () => {
		for await (const chunk of handler.createMessage(system, [{ role: "user", content: user }])) {
			if (signal.aborted) break
			if (chunk.type === "text") {
				text += chunk.text
			} else if (chunk.type === "done" && chunk.success === false) {
				streamError = chunk.error
			}
		}
	}
	const aborted = new Promise<never>((_, reject) => {
		const onAbort = () => {
			handler.abort?.()
			reject(new Error("the distillation model did not answer in time"))
		}
		if (signal.aborted) onAbort()
		else signal.addEventListener("abort", onAbort, { once: true })
	})
	await Promise.race([consume(), aborted])
	if (!text && streamError) {
		throw new Error(streamError)
	}
	return text
}

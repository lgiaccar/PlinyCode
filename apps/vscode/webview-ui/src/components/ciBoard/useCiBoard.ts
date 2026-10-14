import { type CiBoardState, RunCiActionRequest } from "@shared/proto/cline/ci_board"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect, useState } from "react"
import { CiBoardServiceClient } from "@/services/grpc-client"

/** The live CI board; undefined until the extension has answered. Subscribing makes the board poll faster. */
export function useCiBoard(): CiBoardState | undefined {
	const [state, setState] = useState<CiBoardState>()
	useEffect(() => {
		const unsubscribe = CiBoardServiceClient.subscribeToCiBoard(EmptyRequest.create({}), {
			onResponse: (response: CiBoardState) => setState(response),
			onError: (error: unknown) => console.error("Error in CI board subscription:", error),
			onComplete: () => {},
		})
		return unsubscribe
	}, [])
	return state
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The key `useCiRun` marks a starting run with: the action, scoped to a pipeline or not. */
export const runKey = (actionId: string, pipeline = "") => `${actionId}|${pipeline}`

/**
 * Starts an item's actions, on the whole pull request or on one pipeline.
 * `busy` is the `runKey` of the run being started, so its button can spin.
 */
export function useCiRun(targetId: string, itemKey: string, onError: (message: string | undefined) => void) {
	const [busy, setBusy] = useState<string>()
	const run = useCallback(
		async (actionId: string, pipeline = "") => {
			setBusy(runKey(actionId, pipeline))
			onError(undefined)
			try {
				await CiBoardServiceClient.runCiAction(RunCiActionRequest.create({ targetId, itemKey, actionId, pipeline }))
			} catch (e) {
				onError(errorText(e))
			} finally {
				setBusy(undefined)
			}
		},
		[targetId, itemKey, onError],
	)
	return { busy, run }
}

import type { CiBoardState } from "@shared/proto/cline/ci_board"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useEffect, useState } from "react"
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

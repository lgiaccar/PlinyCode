import { fetch as baseFetch } from "@/shared/net"

/** Pliny self-hosted models need long request budgets (see FINDINGS.md). */
export const PLINY_REQUEST_TIMEOUT_MS = 300_000

/**
 * Fetch wrapper for Pliny: long AbortSignal timeout on top of the
 * platform-configured fetch (VS Code OS CA trust + proxy).
 *
 * Plain Node against Pliny needs `--use-system-ca` / NODE_EXTRA_CA_CERTS;
 * the Extension Development Host inherits VS Code's OS trust store, so we
 * keep this wrapper focused on timeouts and let callers set NODE_EXTRA_CA_CERTS
 * when running outside VS Code.
 */
export function createPlinyFetch(timeoutMs: number = PLINY_REQUEST_TIMEOUT_MS): typeof globalThis.fetch {
	return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const timeoutSignal = AbortSignal.timeout(timeoutMs)
		const signal =
			init?.signal !== undefined && init.signal !== null ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
		return baseFetch(input, { ...init, signal })
	}) as typeof globalThis.fetch
}

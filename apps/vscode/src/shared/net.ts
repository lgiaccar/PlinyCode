/**
 * # Network Support for Cline
 *
 * ## Development Guidelines
 *
 * **Do** use `import { fetch } from '@/shared/net'` instead of global `fetch`.
 *
 * Global `fetch` will appear to work in VSCode, but proxy support will be
 * broken in JetBrains or CLI.
 *
 * If you use Axios, **do** call `getAxiosSettings()` and spread into
 * your Axios configuration:
 *
 * ```typescript
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, {
 *   headers: { 'X-FOO': 'BAR' },
 *   ...getAxiosSettings()
 * })
 * ```
 *
 * **Do** remember to pass our `fetch` into your API clients:
 *
 * ```typescript
 * import OpenAI from "openai"
 * import { fetch } from "@/shared/net"
 * this.client = new OpenAI({
 *   apiKey: '...',
 *   fetch, // Use configured fetch with proxy support
 * })
 * ```
 *
 * If you neglect this step, inference won't work in JetBrains and CLI
 * through proxies.
 *
 * ## Proxy Support
 *
 * Cline uses platform-specific fetch implementations to handle proxy
 * configuration:
 * - **VSCode**: Uses global fetch (VSCode provides proxy configuration)
 * - **JetBrains, CLI**: Uses undici fetch with explicit ProxyAgent
 *
 * Proxy configuration via standard environment variables:
 * - `http_proxy` / `HTTP_PROXY` - Proxy for HTTP requests
 * - `https_proxy` / `HTTPS_PROXY` - Proxy for HTTPS requests
 * - `no_proxy` / `NO_PROXY` - Comma-separated list of hosts to bypass proxy
 *
 * Note, `http_proxy` etc. MUST specify the protocol to use for the proxy,
 * for example, `https_proxy=http://proxy.corp.example:3128`. Simply specifying
 * the proxy hostname will result in errors.
 *
 * ## Certificate Trust
 *
 * Proxies often machine-in-the-middle HTTPS connections. To make this work,
 * they generate self-signed certificates for a host, and the client is
 * configured to trust the proxy as a certificate authority.
 *
 * VSCode transparently pulls trusted certificates from the operating system
 * and configures node trust.
 *
 * Not every editor host does (some Cursor builds don't), and the Pliny gateway
 * omits its intermediate certificate. So when a request fails certificate
 * verification, `fetch` retries it once with Node's roots, the OS store and
 * the bundled Synopsys CAs (see tls-trust.ts), and keeps doing so for that
 * origin.
 *
 * JetBrains exports trusted certificates from the OS and writes them to a
 * temporary file, then configures node TLS by setting NODE_EXTRA_CA_CERTS.
 *
 * The CLI's npm wrapper (bin/cline) does the same automatically: it harvests
 * the OS trust store and points the child's NODE_EXTRA_CA_CERTS at a managed
 * bundle, because the Bun runtime does not read the OS store on its own. A
 * user-set NODE_EXTRA_CA_CERTS is merged in rather than replaced.
 *
 * ## Limitations in JetBrains & CLI
 *
 * - Proxy settings are static at startup--restart required for changes
 * - SOCKS proxies, PAC files not supported
 * - Proxy authentication via env vars only
 *
 * These are not fundamental limitations, they just need integration work.
 *
 * ## Troubleshooting
 *
 * 1. Verify proxy env vars: `echo $http_proxy $https_proxy`
 * 2. Check certificates: `echo $NODE_EXTRA_CA_CERTS` (should point to PEM file)
 * 3. View logs: Check ~/.cline/cline-core-service.log for network-related
 *    failures.
 * 4. Test connection: Use `curl -x host:port` etc. to isolate proxy
 *    configuration versus client issues.
 *
 * @example
 * ```typescript
 * // Good - uses configured fetch
 * import { fetch } from '@/shared/net'
 * const response = await fetch(url)
 *
 * // Good - configures axios to use configured fetch
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, { ...getAxiosSettings() })
 * ```
 */

import { EnvHttpProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici"
import { Logger } from "./services/Logger"
import { isTlsTrustError, trustedCaCertificates } from "./tls-trust"

type FetchFunction = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

let mockFetch: FetchFunction | undefined

function requestOrigin(input: string | URL | Request): string | undefined {
	try {
		return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).origin
	} catch {
		return undefined
	}
}

/** Only string/URL requests whose body is not a one-shot stream can be sent a second time. */
function canReplay(input: string | URL | Request, init?: RequestInit): boolean {
	return (typeof input === "string" || input instanceof URL) && !(init?.body instanceof ReadableStream)
}

/**
 * Platform-configured fetch that respects proxy settings.
 * Use this instead of global fetch to ensure proper proxy configuration.
 *
 * @example
 * ```typescript
 * import { fetch } from '@/shared/net'
 * const response = await fetch('https://api.example.com')
 * ```
 */
export const fetch: typeof globalThis.fetch = (() => {
	// Note: Don't use Logger here; it may not be initialized.

	let baseFetch: typeof globalThis.fetch = globalThis.fetch
	// Note: See esbuild.mjs, process.env.IS_STANDALONE is statically rewritten
	// to "true" or "false" (as strings) in the JetBrains/CLI build.
	// We must use explicit string comparison because "false" is truthy in JS.
	if (process.env.IS_STANDALONE === "true") {
		// Configure undici with ProxyAgent
		const agent = new EnvHttpProxyAgent({})
		setGlobalDispatcher(agent)
		baseFetch = undiciFetch as any as typeof globalThis.fetch
	}

	// Fallback for hosts whose chain the default trust store cannot verify (see
	// tls-trust.ts): retried once with the extra CAs, then used for that origin
	// from then on. Built lazily so a machine that never needs it pays nothing.
	const trustedOrigins = new Set<string>()
	let trustedFetch: typeof globalThis.fetch | undefined
	const getTrustedFetch = (): typeof globalThis.fetch => {
		if (!trustedFetch) {
			const ca = trustedCaCertificates()
			const dispatcher = new EnvHttpProxyAgent({ connect: { ca }, requestTls: { ca } })
			trustedFetch = ((input: string | URL, init?: RequestInit) =>
				undiciFetch(input, { ...(init as any), dispatcher })) as any as typeof globalThis.fetch
		}
		return trustedFetch
	}

	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		if (mockFetch) {
			return mockFetch(input, init)
		}
		const origin = requestOrigin(input)
		const replayable = canReplay(input, init)
		if (origin && replayable && trustedOrigins.has(origin)) {
			return getTrustedFetch()(input, init)
		}
		try {
			return await baseFetch(input, init)
		} catch (error) {
			if (!origin || !replayable || !isTlsTrustError(error)) {
				throw error
			}
			trustedOrigins.add(origin)
			Logger.warn(
				`[net] ${origin}: certificate chain not trusted by the default store (${String((error as Error)?.cause ?? error)}); retrying with the OS store and bundled Synopsys CAs`,
			)
			return getTrustedFetch()(input, init)
		}
	}) as typeof globalThis.fetch
})()

/**
 * Mocks `fetch` for testing and calls `callback`. Then restores `fetch`. If the
 * specified callback returns a Promise, the fetch is restored when that Promise
 * is settled.
 * @param theFetch the replacement function to call to implement `fetch`.
 * @param callback `fetch` will be mocked for the duration of `callback()`.
 * @returns the result of `callback()`.
 */
export function mockFetchForTesting<T>(theFetch: FetchFunction, callback: () => T): T {
	const originalMockFetch = mockFetch
	mockFetch = theFetch
	let willResetSync = true
	try {
		const result = callback()
		if (result instanceof Promise) {
			willResetSync = false
			return result.finally(() => {
				mockFetch = originalMockFetch
			}) as typeof result
		}
		return result
	} finally {
		if (willResetSync) {
			mockFetch = originalMockFetch
		}
	}
}

/**
 * Returns axios configuration for fetch adapter mode with our configured fetch.
 * This ensures axios uses our platform-specific fetch implementation with
 * proper proxy configuration.
 *
 * @returns Configuration object with fetch adapter and configured fetch
 *
 * @example
 * ```typescript
 * const response = await axios.get(url, {
 *   headers: { Authorization: 'Bearer token' },
 *   timeout: 5000,
 *   ...getAxiosSettings()
 * })
 * ```
 */
export function getAxiosSettings(): {
	adapter?: any
	fetch?: typeof globalThis.fetch
	maxBodyLength?: number
	maxContentLength?: number
} {
	return {
		adapter: "fetch" as any,
		fetch, // Use our configured fetch
		maxBodyLength: Number.POSITIVE_INFINITY,
		maxContentLength: Number.POSITIVE_INFINITY,
	}
}

import { X509Certificate } from "node:crypto"
import tls from "node:tls"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isTlsTrustError, SYNOPSYS_CA_CERTIFICATES, trustedCaCertificates } from "../tls-trust"

const undiciFetch = vi.fn()
const agentOptions: unknown[] = []

vi.mock("undici", () => ({
	EnvHttpProxyAgent: class {
		constructor(options: unknown) {
			agentOptions.push(options)
		}
	},
	setGlobalDispatcher: vi.fn(),
	fetch: (...args: unknown[]) => undiciFetch(...args),
}))

function certFailure(code: string): TypeError {
	return new TypeError("fetch failed", { cause: Object.assign(new Error(code.toLowerCase()), { code }) })
}

describe("isTlsTrustError", () => {
	it("finds a trust failure in the cause chain", () => {
		expect(isTlsTrustError(certFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toBe(true)
		expect(isTlsTrustError(certFailure("SELF_SIGNED_CERT_IN_CHAIN"))).toBe(true)
	})

	it("ignores failures that extra trust cannot fix", () => {
		expect(isTlsTrustError(certFailure("CERT_HAS_EXPIRED"))).toBe(false)
		expect(isTlsTrustError(certFailure("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe(false)
		expect(isTlsTrustError(certFailure("ECONNREFUSED"))).toBe(false)
		expect(isTlsTrustError(undefined)).toBe(false)
	})
})

describe("trustedCaCertificates", () => {
	it("bundles the Synopsys intermediate and root", () => {
		const subjects = SYNOPSYS_CA_CERTIFICATES.map((pem) => new X509Certificate(pem).subject)
		expect(subjects.some((s) => s.includes("CN=SNPSica2"))).toBe(true)
		expect(subjects.some((s) => s.includes("CN=SNPSOfflineCA"))).toBe(true)
	})

	it("keeps Node's roots alongside the extra CAs", () => {
		const bundle = trustedCaCertificates()
		expect(bundle).toEqual(expect.arrayContaining([...tls.rootCertificates, ...SYNOPSYS_CA_CERTIFICATES]))
	})
})

describe("fetch certificate fallback", () => {
	const baseFetch = vi.fn()

	beforeEach(() => {
		vi.resetModules()
		baseFetch.mockReset()
		undiciFetch.mockReset()
		agentOptions.length = 0
		vi.stubGlobal("fetch", baseFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	async function loadFetch() {
		return (await import("../net")).fetch
	}

	it("retries a trust failure with the extra CAs, then sticks to them for that origin", async () => {
		baseFetch.mockRejectedValue(certFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))
		undiciFetch.mockResolvedValue(new Response("ok"))
		const fetch = await loadFetch()

		const response = await fetch("https://gateway.example/api/llm/chat", { method: "POST", body: "{}" })
		expect(await response.text()).toBe("ok")
		expect(undiciFetch).toHaveBeenCalledWith(
			"https://gateway.example/api/llm/chat",
			expect.objectContaining({ method: "POST", body: "{}", dispatcher: expect.anything() }),
		)
		const [options] = agentOptions as { connect: { ca: string[] }; requestTls: { ca: string[] } }[]
		expect(options.connect.ca).toEqual(expect.arrayContaining([...SYNOPSYS_CA_CERTIFICATES]))
		expect(options.requestTls.ca).toBe(options.connect.ca)

		await fetch("https://gateway.example/api/llm/models")
		expect(baseFetch).toHaveBeenCalledTimes(1)
		expect(undiciFetch).toHaveBeenCalledTimes(2)
	})

	it("leaves other origins on the default fetch", async () => {
		baseFetch.mockRejectedValueOnce(certFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE")).mockResolvedValue(new Response("plain"))
		undiciFetch.mockResolvedValue(new Response("ok"))
		const fetch = await loadFetch()

		await fetch("https://gateway.example/")
		expect(await (await fetch("https://other.example/")).text()).toBe("plain")
		expect(undiciFetch).toHaveBeenCalledTimes(1)
	})

	it("rethrows failures that are not certificate trust problems", async () => {
		const failure = certFailure("ECONNREFUSED")
		baseFetch.mockRejectedValue(failure)
		const fetch = await loadFetch()

		await expect(fetch("https://gateway.example/")).rejects.toBe(failure)
		expect(undiciFetch).not.toHaveBeenCalled()
	})

	it("does not replay a streamed body", async () => {
		const failure = certFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
		baseFetch.mockRejectedValue(failure)
		const fetch = await loadFetch()

		await expect(fetch("https://gateway.example/", { method: "POST", body: new ReadableStream() })).rejects.toBe(failure)
		expect(undiciFetch).not.toHaveBeenCalled()
	})

	it("passes straight through when the default fetch succeeds", async () => {
		baseFetch.mockResolvedValue(new Response("plain"))
		const fetch = await loadFetch()

		expect(await (await fetch("https://gateway.example/")).text()).toBe("plain")
		expect(undiciFetch).not.toHaveBeenCalled()
		expect(agentOptions).toHaveLength(0)
	})
})

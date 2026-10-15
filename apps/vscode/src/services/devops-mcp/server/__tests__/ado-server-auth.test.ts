import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { adoServerSignInHost, adoServerSignInMessage, adoServerTokenPage } from "../../../../shared/adoServerAuth"
import type { BrokerProvider } from "../../shared/broker-protocol"
import { adoAuth, type EditorTokenSource } from "../auth"
import { AzureDevOpsProvider } from "../providers/azdo"
import { parseRemote } from "../repo"
import { FakeApi } from "./fake-api"

const ON_PREM = parseRemote("https://tfs.example.com/tfs/Some_Collection/Meshing/_git/AlphaWrap")
const CLOUD = parseRemote("https://dev.azure.com/org/project/_git/repo")
const PROJ = "/tfs/Some_Collection/Meshing/_apis"
const basic = (pat: string) => `Basic ${Buffer.from(`:${pat}`).toString("base64")}`

interface Call {
	provider: BrokerProvider
	host: string
	interactive: boolean
	server?: string
}

/** An editor token source that records its calls and answers from `tokens` (keyed by provider). */
function editor(tokens: Partial<Record<BrokerProvider, string>>): { source: EditorTokenSource; calls: Call[] } {
	const calls: Call[] = []
	const source: EditorTokenSource = async (provider, host, interactive, server) => {
		calls.push({ provider, host, interactive, server })
		return tokens[provider]
	}
	return { source, calls }
}

describe("Azure DevOps Server sign-in", () => {
	const saved = { pat: process.env.AZURE_DEVOPS_PAT, ext: process.env.AZURE_DEVOPS_EXT_PAT }

	beforeEach(() => {
		delete process.env.AZURE_DEVOPS_PAT
		delete process.env.AZURE_DEVOPS_EXT_PAT
	})

	afterEach(() => {
		if (saved.pat === undefined) delete process.env.AZURE_DEVOPS_PAT
		else process.env.AZURE_DEVOPS_PAT = saved.pat
		if (saved.ext === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT
		else process.env.AZURE_DEVOPS_EXT_PAT = saved.ext
	})

	it("sends the token stored for the host as Basic auth, never a Microsoft sign-in", async () => {
		const { source, calls } = editor({ "ado-server": "stored-pat", ado: "entra-token" })
		expect(await adoAuth(ON_PREM, source).header()).toBe(basic("stored-pat"))
		expect(calls).toEqual([
			{
				provider: "ado-server",
				host: "tfs.example.com",
				interactive: false,
				server: "https://tfs.example.com/tfs/Some_Collection",
			},
		])
	})

	it("prefers the stored token over AZURE_DEVOPS_PAT, and falls back to it", async () => {
		process.env.AZURE_DEVOPS_PAT = "env-pat"
		expect(await adoAuth(ON_PREM, editor({ "ado-server": "stored-pat" }).source).header()).toBe(basic("stored-pat"))
		const { source, calls } = editor({})
		expect(await adoAuth(ON_PREM, source).header()).toBe(basic("env-pat"))
		expect(calls.map((c) => c.interactive)).toEqual([false])
	})

	it("asks the editor's prompt last, and names the host when there is no token", async () => {
		const prompted = editor({})
		await expect(adoAuth(ON_PREM, prompted.source).header()).rejects.toThrow(adoServerSignInMessage("tfs.example.com"))
		expect(prompted.calls.map((c) => [c.provider, c.interactive])).toEqual([
			["ado-server", false],
			["ado-server", true],
		])
	})

	it("adds the sign-in hint when the server still answers 401", async () => {
		const api = new FakeApi()
		const provider = new AzureDevOpsProvider(ON_PREM, api.fetch, adoAuth(ON_PREM, editor({ "ado-server": "bad" }).source))
		api.on(
			"GET",
			`${PROJ}/git/repositories/AlphaWrap`,
			{ message: "TF400813: Resource not available for anonymous access." },
			401,
		)
		const error = await provider.defaultBranch().catch((e: Error) => e)
		expect(String(error)).toContain("TF400813")
		expect(adoServerSignInHost(String(error))).toBe("tfs.example.com")
		expect(api.requests.map((r) => r.headers.Authorization)).toEqual([basic("bad"), basic("bad")])
	})

	it("keeps Azure DevOps Services on the Microsoft sign-in", async () => {
		const { source, calls } = editor({ ado: "entra-token" })
		expect(await adoAuth(CLOUD, source).header()).toBe("Bearer entra-token")
		expect(calls[0]).toMatchObject({ provider: "ado", host: "dev.azure.com" })
	})
})

describe("adoServerAuth helpers", () => {
	it("finds the host in an error that carries the sign-in sentence", () => {
		expect(adoServerSignInHost(`GET /x -> HTTP 401: nope. ${adoServerSignInMessage("ado.internal.example.com")} Use …`)).toBe(
			"ado.internal.example.com",
		)
		expect(adoServerSignInHost("GET /x -> HTTP 401: TF400813")).toBeUndefined()
		expect(adoServerSignInHost(undefined)).toBeUndefined()
	})

	it("builds the token page from the collection URL", () => {
		expect(adoServerTokenPage("https://tfs.example.com/tfs/Some_Collection/")).toBe(
			"https://tfs.example.com/tfs/Some_Collection/_usersSettings/tokens",
		)
	})
})

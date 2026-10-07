import { describe, expect, it } from "bun:test"
import { classifyTargetInput, parsePrLink } from "../pr-link"

describe("parsePrLink", () => {
	it("reads github.com links, with or without a trailing tab or query", () => {
		for (const url of [
			"https://github.com/octo/hello/pull/12",
			"https://github.com/octo/hello/pull/12/files",
			"https://github.com/octo/hello/pull/12?w=1#discussion",
		]) {
			const link = parsePrLink(url)
			expect(link?.prId).toBe(12)
			expect(link?.remote).toEqual({ kind: "github", host: "github.com", owner: "octo", repo: "hello" })
			expect(link?.remoteUrl).toBe("https://github.com/octo/hello")
		}
	})

	it("treats any host with a /pull/N path as GitHub (Enterprise)", () => {
		expect(parsePrLink("https://git.example.com/team/tool/pull/3")?.remote).toEqual({
			kind: "github",
			host: "git.example.com",
			owner: "team",
			repo: "tool",
		})
	})

	it("reads Azure DevOps cloud links", () => {
		const link = parsePrLink("https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42")
		expect(link?.prId).toBe(42)
		expect(link?.remote).toMatchObject({ kind: "ado", owner: "acme", project: "My Project", repo: "web-app" })
		expect(parsePrLink("https://acme.visualstudio.com/Proj/_git/repo/pullrequest/5")?.remote).toMatchObject({
			kind: "ado",
			owner: "acme",
			project: "Proj",
		})
	})

	it("reads on-premises Azure DevOps Server links, keeping the collection path", () => {
		const link = parsePrLink(
			"https://ado.internal.synopsys.com/tfs/Some_Collection/Meshing/_git/GPUSurfer/pullrequest/731701?_a=files",
		)
		expect(link?.prId).toBe(731701)
		expect(link?.remote).toMatchObject({
			kind: "ado",
			host: "ado.internal.synopsys.com",
			collection: "tfs/Some_Collection",
			project: "Meshing",
			repo: "GPUSurfer",
			origin: "https://ado.internal.synopsys.com",
		})
		expect(link?.remoteUrl).toBe("https://ado.internal.synopsys.com/tfs/Some_Collection/Meshing/_git/GPUSurfer")
	})

	it("rejects anything else", () => {
		for (const text of ["https://github.com/octo/hello", "https://github.com/octo/hello/issues/3", "feature", ""]) {
			expect(parsePrLink(text)).toBeUndefined()
		}
	})
})

describe("classifyTargetInput", () => {
	it("tells links, branches and junk apart", () => {
		expect(classifyTargetInput(" https://github.com/octo/hello/pull/1 ").kind).toBe("pr")
		expect(classifyTargetInput("lgiaccar/advanced_ci_watcher")).toEqual({
			kind: "branch",
			branch: "lgiaccar/advanced_ci_watcher",
		})
		expect(classifyTargetInput("https://github.com/octo/hello").kind).toBe("invalid")
		expect(classifyTargetInput("two words").kind).toBe("invalid")
		expect(classifyTargetInput("bad..name").kind).toBe("invalid")
		expect(classifyTargetInput("").kind).toBe("invalid")
	})
})

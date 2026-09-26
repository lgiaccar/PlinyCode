import { describe, expect, it } from "bun:test"
import { DevOpsError } from "../errors"
import { failureExcerpt } from "../providers/github"
import { parseRemote } from "../repo"
import { setSection } from "../report"

describe("parseRemote", () => {
	it.each([
		"git@github.com:octo/hello.git",
		"https://github.com/octo/hello.git",
		"https://github.com/octo/hello",
		"ssh://git@github.com/octo/hello.git",
	])("parses GitHub remote %s", (url) => {
		expect(parseRemote(url)).toEqual({ kind: "github", host: "github.com", owner: "octo", repo: "hello" })
	})

	it.each([
		"https://dev.azure.com/acme/My%20Project/_git/web-app",
		"https://jdoe@dev.azure.com/acme/My%20Project/_git/web-app",
		"git@ssh.dev.azure.com:v3/acme/My%20Project/web-app",
		"https://acme.visualstudio.com/My%20Project/_git/web-app",
		"https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/web-app",
		"acme@vs-ssh.visualstudio.com:v3/acme/My%20Project/web-app",
	])("parses Azure DevOps remote %s", (url) => {
		expect(parseRemote(url)).toEqual({
			kind: "ado",
			host: "dev.azure.com",
			owner: "acme",
			repo: "web-app",
			project: "My Project",
		})
	})

	it("needs a provider for unknown hosts", () => {
		expect(() => parseRemote("git@git.corp.example:team/tool.git")).toThrow(/DEVOPS_MCP_PROVIDER/)
		expect(parseRemote("git@git.corp.example:team/tool.git", "github")).toEqual({
			kind: "github",
			host: "git.corp.example",
			owner: "team",
			repo: "tool",
		})
	})

	it("auto-detects an on-premises Azure DevOps Server (TFS) from its `_git` path, without DEVOPS_MCP_PROVIDER", () => {
		expect(parseRemote("https://ado.internal.example.com/tfs/MyCollection/MyProject/_git/my-repo")).toEqual({
			kind: "ado",
			host: "ado.internal.example.com",
			owner: "MyCollection",
			repo: "my-repo",
			project: "MyProject",
			collection: "MyCollection",
			origin: "https://ado.internal.example.com",
		})
	})

	it("parses an on-premises ssh:// remote with a port, defaulting the API origin to https", () => {
		expect(parseRemote("ssh://ado.internal.example.com:22/tfs/MyCollection/MyProject/_git/my-repo")).toEqual({
			kind: "ado",
			host: "ado.internal.example.com",
			owner: "MyCollection",
			repo: "my-repo",
			project: "MyProject",
			collection: "MyCollection",
			origin: "https://ado.internal.example.com:22",
		})
	})
})

describe("setSection", () => {
	it("appends a section, then replaces only that section", () => {
		const once = setSection("Hand-written summary.", "ci", "CI: pending")
		expect(once).toBe("Hand-written summary.\n\n<!-- devops-mcp:ci -->\nCI: pending\n<!-- /devops-mcp:ci -->\n")
		const twice = setSection(`${once}\nFooter`, "ci", "CI: passed")
		expect(twice).not.toContain("CI: pending")
		expect(twice.startsWith("Hand-written summary.")).toBe(true)
		expect(twice.endsWith("Footer")).toBe(true)
	})

	it("handles an empty body and `$` sequences in content", () => {
		expect(setSection("", "ci", "a $& b")).toBe("<!-- devops-mcp:ci -->\na $& b\n<!-- /devops-mcp:ci -->\n")
		expect(() => setSection("", "bad name", "x")).toThrow(DevOpsError)
	})
})

describe("failureExcerpt", () => {
	it("ends at the last ##[error] line instead of the cleanup tail", () => {
		const log = [
			...Array(5).fill("setup"),
			"boom",
			"##[error]Process completed with exit code 1.",
			...Array(20).fill("cleanup"),
		].join("\n")
		expect(failureExcerpt(log, 2)).toBe("boom\n##[error]Process completed with exit code 1.")
		expect(failureExcerpt("a\nb\nc", 2)).toBe("b\nc")
	})
})

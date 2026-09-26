import { describe, expect, it } from "vitest"
import { isPotentialFilePath, splitTextFilePaths } from "./filePathDetection"

describe("isPotentialFilePath", () => {
	it.each([
		"src/foo.ts",
		"README.md",
		"src\\core\\index.ts",
		"d:\\dev0\\GPUSurfer\\ai_output\\reports\\branch_16_levelset_root_cause.md",
		"C:/Users/me/My Docs/notes.md",
		"/home/me/project/file.py",
	])("accepts %s", (value) => {
		expect(isPotentialFilePath(value)).toBe(true)
	})

	it.each(["", "foo bar", "/", "src/", "a\nb", "npm run build", "C:\\"])("rejects %j", (value) => {
		expect(isPotentialFilePath(value)).toBe(false)
	})
})

describe("splitTextFilePaths", () => {
	it("finds a lowercase-drive Windows path in prose", () => {
		expect(
			splitTextFilePaths(
				"The full analysis is at: d:\\dev0\\GPUSurfer\\ai_output\\reports\\branch_16_levelset_root_cause.md",
			),
		).toEqual([
			{ type: "text", value: "The full analysis is at: " },
			{ type: "path", value: "d:\\dev0\\GPUSurfer\\ai_output\\reports\\branch_16_levelset_root_cause.md" },
		])
	})

	it("strips trailing sentence punctuation", () => {
		expect(splitTextFilePaths("See C:/work/out/report.md. Then rerun.")).toEqual([
			{ type: "text", value: "See " },
			{ type: "path", value: "C:/work/out/report.md" },
			{ type: "text", value: ". Then rerun." },
		])
	})

	it("finds POSIX absolute paths only when they end in a file name with an extension", () => {
		expect(splitTextFilePaths("wrote /tmp/out/log.txt")).toEqual([
			{ type: "text", value: "wrote " },
			{ type: "path", value: "/tmp/out/log.txt" },
		])
		expect(splitTextFilePaths("and/or /api/v1/budgets")).toBeUndefined()
	})

	it("leaves text without paths alone", () => {
		expect(splitTextFilePaths("nothing to see: 3:45 and a/b")).toBeUndefined()
		expect(splitTextFilePaths("https://example.com/a/b.md")).toBeUndefined()
	})
})

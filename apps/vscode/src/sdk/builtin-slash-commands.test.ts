import { describe, expect, it } from "vitest"
import { BUILTIN_SLASH_COMMANDS } from "./builtin-slash-commands"
import { expandSlashCommands } from "./slash-command-expansion"

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("expands /deep-planning through the shared slash-command machinery", () => {
		const result = expandSlashCommands("/deep-planning add a factorial function", BUILTIN_SLASH_COMMANDS)
		expect(result).toContain('<explicit_instructions type="deep-planning">')
		expect(result).toContain("add a factorial function")
		expect(result).not.toContain("/deep-planning")
	})

	it("expands /remember into instructions to call save_memory, followed by what to remember", () => {
		const result = expandSlashCommands("/remember we deploy from stage", BUILTIN_SLASH_COMMANDS)
		expect(result).toContain('<explicit_instructions type="remember">')
		expect(result).toContain("save_memory")
		expect(result.trimEnd().endsWith("What to remember: we deploy from stage")).toBe(true)
	})

	it("leaves URLs and unrelated text unchanged", () => {
		expect(expandSlashCommands("see http://x.com/deep-planning", BUILTIN_SLASH_COMMANDS)).toBe(
			"see http://x.com/deep-planning",
		)
		expect(expandSlashCommands("hello world", BUILTIN_SLASH_COMMANDS)).toBe("hello world")
	})
})

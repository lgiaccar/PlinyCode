import { describe, expect, it } from "bun:test"
import { classifyShellPrompt, getLastLine, looksLikeInputPrompt, looksLikeShellPrompt } from "./shellPromptHeuristics"

describe("looksLikeInputPrompt", () => {
	it.each([
		["yes/no in brackets", "Overwrite existing file? [y/N]"],
		["yes/no in parentheses", "Do you want to continue? (yes/no)"],
		["three-way choice", "Replace file.txt? [Y/n/a]:"],
		["password", "Password:"],
		["passphrase", "Enter passphrase for key '/home/me/.ssh/id_ed25519':"],
		["git username", "Username for 'https://github.com':"],
		["press any key", "Press any key to continue . . ."],
		["press enter", "Press ENTER to exit"],
		["are you sure", "Are you sure you want to delete the branch?"],
		["proceed", "Proceed with installation?"],
		["select", "Select an option:"],
		["choose with angle bracket", "Choose your preset >"],
		["default value", "Project name (default: my-app):"],
		["inquirer default", "Which package manager? [default=npm]"],
		["question with options", "Continue? [Y/n]"],
	])("detects %s", (_name, line) => {
		expect(looksLikeInputPrompt(line)).toBe(true)
	})

	it.each([
		["empty", ""],
		["plain progress", "Compiling module foo"],
		["log line ending in colon", "Building target GPUSurfer:"],
		["shell prompt", "PS C:\\Users\\me> "],
		["bash prompt", "user@host:~$ "],
		[
			"a question in prose that is long",
			"The question is whether the cache should be invalidated when the configuration file changes, or only when the schema version bumps; that decision affects every consumer of the settings service and its tests?",
		],
		["timestamped log", "12:34:56 INFO waiting for the database to accept connections"],
		["test summary", "Tests: 12 passed, 0 failed"],
	])("ignores %s", (_name, line) => {
		expect(looksLikeInputPrompt(line)).toBe(false)
	})
})

describe("getLastLine", () => {
	it("returns the whole string when there are no newlines", () => {
		expect(getLastLine("user@host:~$ ")).toBe("user@host:~$ ")
	})

	it("returns the last line, ignoring trailing newlines", () => {
		expect(getLastLine("output\nuser@host:~$ \n")).toBe("user@host:~$ ")
	})

	it("returns content after the last carriage return (line overwrite)", () => {
		expect(getLastLine("progress 10%\rprogress 100%")).toBe("progress 100%")
	})

	it("returns empty string for empty or newline-only input", () => {
		expect(getLastLine("")).toBe("")
		expect(getLastLine("\n\r\n")).toBe("")
	})
})

describe("looksLikeShellPrompt", () => {
	it.each([
		["bash", "user@host:~$ "],
		["bash root", "root@host:/etc# "],
		["zsh", "host% "],
		["fish/generic", "~/project> "],
		["python REPL", ">>> "],
		["starship", "\u276f "],
		["powershell", "PS C:\\Users\\me> "],
		["command prompt", "C:\\Users\\me>"],
	])("detects %s prompt", (_name, line) => {
		expect(looksLikeShellPrompt(line)).toBe(true)
	})

	it.each([
		["empty", ""],
		["whitespace only", "   "],
		["regular output", "Compiling module foo"],
		["sentence", "Done."],
		["progress", "downloading 57%|"],
	])("does not detect %s as a prompt", (_name, line) => {
		expect(looksLikeShellPrompt(line)).toBe(false)
	})
})

describe("classifyShellPrompt", () => {
	it.each([
		["bash", "user@host:~$ "],
		["bash root", "root@host:/etc# "],
		["starship", "\u276f "],
		["powershell", "PS C:\\Users\\me> "],
		["command prompt", "C:\\Users\\me>"],
		["python REPL", ">>>"],
	])("classifies %s prompt as strong", (_name, line) => {
		expect(classifyShellPrompt(line)).toBe("strong")
	})

	it.each([
		["zsh", "host% "],
		["fish/generic", "~/project> "],
	])("classifies %s prompt as weak", (_name, line) => {
		expect(classifyShellPrompt(line)).toBe("weak")
	})

	it.each([
		["empty", ""],
		["whitespace only", "   "],
		["regular output", "Compiling module foo"],
		["sentence", "Done."],
	])("classifies %s as none", (_name, line) => {
		expect(classifyShellPrompt(line)).toBe("none")
	})

	// These are the false-positive shapes a still-running command can produce
	// that end in a generic prompt character — they must not be trusted as a
	// "strong" match, since a hung ssh session's continuation prompt, an
	// unterminated HTML/XML tag, or a progress meter should not short-circuit
	// the markerless completion check the same way a real shell prompt does.
	it.each([
		["a hung ssh session's continuation prompt", "chunk >"],
		["an HTML/XML tag", "<div>"],
		["a progress meter", "downloading 100%"],
		["a nested-shell prompt fragment", "> "],
	])("classifies %s as weak, not strong", (_name, line) => {
		expect(classifyShellPrompt(line)).toBe("weak")
	})
})

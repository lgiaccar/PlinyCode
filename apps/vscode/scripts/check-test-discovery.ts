#!/usr/bin/env bun

/**
 * Checks that every `src/**` `*.test.ts` file in the extension is picked up by
 * the runner its imports ask for, and by no other.
 *
 * The extension has four runners for `*.test.ts` files, told apart by what the
 * file imports:
 *
 *   - "bun:test"          -> `bun run test:unit` (scripts/run-bun-unit-tests.ts
 *                            globs every test file and keeps the bun:test ones)
 *   - "vitest"            -> `bun run test:vitest` (vitest.config.ts: directory
 *                            globs in `include`, minus the generated exclude list
 *                            in vitest.exclude.json)
 *   - "mocha"             -> `bun run test:integration` (.vscode-test.mjs, real
 *                            VS Code extension host)
 *   - "@playwright/test"  -> `bun run test:e2e` (playwright.config.ts, src/test/e2e)
 *
 * Vitest cannot filter by import, so the bun:test and mocha files that live under
 * its include directories are listed one by one in vitest.exclude.json. This
 * script owns that list: `--write` regenerates it, and the default (check) mode
 * fails when
 *
 *   (a) a vitest file is not matched by vitest's include/exclude (it would never
 *       run: this is how src/shared/checkpoint-line-diff.test.ts and
 *       src/core/storage/__tests__/StateManager.test.ts were lost),
 *   (b) a non-vitest file is matched by vitest's include but not excluded (vitest
 *       would try to run a bun:test or mocha file and fail), or the exclude list
 *       has stale or wrong entries,
 *   (c) a mocha file lies outside the integration runner's globs,
 *   (d) a test file imports none, or more than one, of the four frameworks.
 *
 * Usage:
 *   bun scripts/check-test-discovery.ts            # check (CI: part of ci:check-all)
 *   bun scripts/check-test-discovery.ts --write    # regenerate vitest.exclude.json
 *   bun scripts/check-test-discovery.ts --list     # print every test file with its runner
 */

import fs from "node:fs"
import path from "node:path"
import { Glob } from "bun"
import picomatch from "picomatch"
import vitestConfig from "../vitest.config"

const projectRoot = path.resolve(import.meta.dir, "..")
const excludeFile = path.join(projectRoot, "vitest.exclude.json")

type Runner = "bun" | "vitest" | "mocha" | "e2e"

const RUNNER_IMPORTS: ReadonlyArray<readonly [Runner, RegExp]> = [
	["bun", /from\s+["']bun:test["']/],
	["vitest", /from\s+["']vitest["']/],
	["mocha", /from\s+["']mocha["']/],
	["e2e", /from\s+["']@playwright\/test["']/],
]

// Mirrors `files` in .vscode-test.mjs (which globs the tsc output under out/).
const MOCHA_INCLUDE = ["src/{core,test,utils,shared,integrations,hosts,services}/**/*.test.ts"]
const MOCHA_EXCLUDE = ["src/**/__tests__/**/*.test.ts", "src/test/services/**/*.test.ts"]

type TestFile = { file: string; runners: Runner[] }

async function collectTestFiles(): Promise<TestFile[]> {
	const files: TestFile[] = []
	for await (const match of new Glob("src/**/*.test.ts").scan({ cwd: projectRoot, onlyFiles: true })) {
		const file = match.split(path.sep).join("/")
		const source = await Bun.file(path.join(projectRoot, file)).text()
		const runners = RUNNER_IMPORTS.filter(([, pattern]) => pattern.test(source)).map(([runner]) => runner)
		files.push({ file, runners })
	}
	return files.sort((a, b) => a.file.localeCompare(b.file))
}

function matcher(patterns: string[]): (file: string) => boolean {
	if (patterns.length === 0) {
		return () => false
	}
	return picomatch(patterns, { dot: true })
}

function readVitestPatterns(): { include: string[]; exclude: string[] } {
	const include = vitestConfig.test?.include
	const exclude = vitestConfig.test?.exclude
	if (!Array.isArray(include) || include.length === 0) {
		throw new Error("vitest.config.ts: test.include must be a non-empty array")
	}
	if (!Array.isArray(exclude)) {
		throw new Error("vitest.config.ts: test.exclude must be an array")
	}
	return { include, exclude }
}

function readExcludeFile(): string[] {
	if (!fs.existsSync(excludeFile)) {
		return []
	}
	const parsed: unknown = JSON.parse(fs.readFileSync(excludeFile, "utf8"))
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error(`${path.basename(excludeFile)} must be a JSON array of strings`)
	}
	return parsed as string[]
}

// One entry per line, tab-indented, trailing newline: the shape Biome's JSON
// formatter produces for this config, so `bun run format` stays green.
function formatExcludeFile(entries: string[]): string {
	if (entries.length === 0) {
		return "[]\n"
	}
	return `[\n${entries.map((entry) => `\t${JSON.stringify(entry)}`).join(",\n")}\n]\n`
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const write = args.includes("--write")
	const list = args.includes("--list")

	const files = await collectTestFiles()
	if (list) {
		for (const { file, runners } of files) {
			console.log(`${(runners.join("+") || "none").padEnd(8)} ${file}`)
		}
	}

	const { include, exclude } = readVitestPatterns()
	const vitestIncluded = matcher(include)
	const mochaIncluded = matcher(MOCHA_INCLUDE)
	const mochaExcluded = matcher(MOCHA_EXCLUDE)

	// The exclude list vitest needs: every non-vitest file its include globs reach.
	const wantedExclude = files
		.filter(({ file, runners }) => !runners.includes("vitest") && vitestIncluded(file))
		.map(({ file }) => file)
	const currentExclude = readExcludeFile()

	if (write) {
		fs.writeFileSync(excludeFile, formatExcludeFile(wantedExclude))
		console.log(`Wrote ${wantedExclude.length} entries to ${path.relative(projectRoot, excludeFile)}`)
	}

	// vitest.config.ts was imported before `--write` touched the file, so check
	// against the list that is on disk now: the config's own patterns plus the
	// file's entries.
	const currentExcludeSet = new Set(currentExclude)
	const configExclude = exclude.filter((pattern) => !currentExcludeSet.has(pattern))
	const vitestExcluded = matcher([...configExclude, ...(write ? wantedExclude : currentExclude)])

	const errors: string[] = []
	const byRunner: Record<Runner, number> = { bun: 0, vitest: 0, mocha: 0, e2e: 0 }

	for (const { file, runners } of files) {
		if (runners.length !== 1) {
			errors.push(
				runners.length === 0
					? `${file}: imports none of bun:test, vitest, mocha or @playwright/test, so no runner picks it up`
					: `${file}: imports more than one test framework (${runners.join(", ")}); a file belongs to exactly one runner`,
			)
			continue
		}
		const runner = runners[0]
		byRunner[runner] += 1
		const runsUnderVitest = vitestIncluded(file) && !vitestExcluded(file)
		if (runner === "vitest" && !runsUnderVitest) {
			errors.push(
				`${file}: imports vitest but vitest.config.ts does not reach it (not matched by test.include, or listed in vitest.exclude.json)`,
			)
		}
		if (runner !== "vitest" && runsUnderVitest) {
			const framework = runner === "bun" ? "bun:test" : runner
			errors.push(
				`${file}: imports ${framework} but vitest would run it; add it to vitest.exclude.json (bun scripts/check-test-discovery.ts --write)`,
			)
		}
		if (runner === "mocha" && !(mochaIncluded(file) && !mochaExcluded(file))) {
			errors.push(
				`${file}: imports mocha but .vscode-test.mjs does not reach it (outside its directory globs, or under __tests__/); move it or make it a bun:test file`,
			)
		}
	}

	const wanted = new Set(wantedExclude)
	for (const entry of currentExclude) {
		if (!wanted.has(entry)) {
			const exists = files.some(({ file }) => file === entry)
			errors.push(
				exists
					? `vitest.exclude.json: ${entry} is a vitest file (or not under test.include) and must not be excluded`
					: `vitest.exclude.json: ${entry} no longer exists`,
			)
		}
	}
	if (errors.length === 0 && currentExclude.join("\n") !== wantedExclude.join("\n")) {
		errors.push(
			"vitest.exclude.json is out of order or incomplete; regenerate it with bun scripts/check-test-discovery.ts --write",
		)
	}

	console.log(
		`Test files: ${files.length} (bun:test ${byRunner.bun}, vitest ${byRunner.vitest}, mocha ${byRunner.mocha}, playwright ${byRunner.e2e}); vitest.exclude.json entries: ${wantedExclude.length}`,
	)
	if (errors.length > 0) {
		console.error(`\n${errors.length} test discovery problem(s):`)
		for (const error of errors) {
			console.error(`  - ${error}`)
		}
		process.exit(1)
	}
	console.log("Every test file is reached by exactly its own runner.")
}

await main()

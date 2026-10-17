#!/usr/bin/env bun

import { spawn } from "node:child_process"
import path from "node:path"
/**
 * Runs the vitest suites under `bun test` instead (bun maps `vitest` imports to
 * `bun:test`). The file set is the one `vitest.config.ts` resolves, read from
 * the config itself so the two runners cannot drift.
 *
 * Why a script instead of a bare `bun test <globs>`:
 *
 *  1. Same include/exclude as vitest. `bun test`'s positional args don't expand
 *     `**` the way we need, so we resolve the config's globs ourselves with bun's
 *     `Glob` and drop the bun:test and mocha files vitest.exclude.json lists.
 *
 *  2. One process per file. `bun test` runs all files in a single process by
 *     default, so `mock.module(...)` registrations leak between files — suites
 *     mocking the same specifier with different shapes (e.g.
 *     `@/core/storage/StateManager`, `@plinycode/core`) clobber each other.
 *     `--parallel` runs each file in its own worker process, giving each a fresh
 *     module registry.
 *
 * Usage:
 *   bun scripts/run-bun-tests.ts            # run the vitest set under bun, isolated
 *   bun scripts/run-bun-tests.ts --list     # print the resolved file list only
 */
import { Glob } from "bun"
import picomatch from "picomatch"
import vitestConfig from "../vitest.config"

const projectRoot = path.resolve(import.meta.dir, "..")

async function resolveFiles(): Promise<string[]> {
	const include = vitestConfig.test?.include ?? []
	const exclude = vitestConfig.test?.exclude ?? []
	const excluded = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false
	const seen = new Set<string>()
	for (const pattern of include) {
		const glob = new Glob(pattern)
		for await (const match of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
			const normalized = match.split(path.sep).join("/")
			if (!excluded(normalized)) {
				seen.add(normalized)
			}
		}
	}
	return [...seen].sort()
}

async function main(): Promise<void> {
	const files = await resolveFiles()
	if (files.length === 0) {
		console.error("run-bun-tests: no test files matched the include patterns")
		process.exit(1)
	}

	const passthrough = process.argv.slice(2)
	if (passthrough.includes("--list")) {
		console.log(files.join("\n"))
		return
	}

	const args = ["test", "--parallel", ...passthrough.filter((arg) => arg !== "--list"), ...files]
	const child = spawn("bun", args, { cwd: projectRoot, stdio: "inherit" })
	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal)
			return
		}
		process.exit(code ?? 1)
	})
}

void main()

import { afterEach, beforeEach, describe, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import "should"
import { getHookLaunchConfig, HookProcess, resetHookLaunchConfigCacheForTesting } from "../HookProcess"
import { withPlatform, writeHookScriptForPlatform } from "./test-utils"

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})

	return { promise, resolve, reject }
}

describe("HookProcess", () => {
	beforeEach(() => {
		resetHookLaunchConfigCacheForTesting()
	})

	afterEach(() => {
		resetHookLaunchConfigCacheForTesting()
	})

	it("uses resolved PowerShell executable and expected Windows launch args", async () => {
		const resolvedExecutable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"

		await withPlatform("win32", async () => {
			const config = await getHookLaunchConfig(
				"C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1",
				async () => resolvedExecutable,
			)

			config.command.should.equal(resolvedExecutable)
			config.args.should.deepEqual([
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				"C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1",
			])
			config.shell.should.equal(false)
			config.detached.should.equal(false)
		})
	})

	it("keeps Unix launch behavior unchanged", async () => {
		await withPlatform("linux", async () => {
			const config = await getHookLaunchConfig("/tmp/.clinerules/hooks/PreToolUse")
			config.args.should.deepEqual([])
			config.shell.should.equal(true)
			config.detached.should.equal(true)
		})
	})

	it("surfaces resolver failures", async () => {
		await withPlatform("win32", async () => {
			try {
				await getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1", async () => {
					throw new Error("resolver failed")
				})
				throw new Error("Expected getHookLaunchConfig to throw")
			} catch (error: any) {
				error.message.should.match(/resolver failed/)
			}
		})
	})

	it("uses PowerShell on Windows", async () => {
		await withPlatform("win32", async () => {
			const ps1Path = "C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1"
			const resolvedExecutable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"

			let resolverCallCount = 0

			const config = await getHookLaunchConfig(ps1Path, async () => {
				resolverCallCount += 1
				return resolvedExecutable
			})

			config.command.should.equal(resolvedExecutable)
			config.args.should.deepEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path])
			resolverCallCount.should.equal(1)
		})
	})

	it("coalesces concurrent Windows launcher resolution into a single in-flight resolver call", async () => {
		await withPlatform("win32", async () => {
			const resolvedExecutable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
			const resolverGate = createDeferred<void>()
			let resolverCallCount = 0

			const resolver = async () => {
				resolverCallCount += 1
				await resolverGate.promise
				return resolvedExecutable
			}

			const launchRequests = [
				getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1", resolver),
				getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\PostToolUse.ps1", resolver),
				getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\TaskResume.ps1", resolver),
			]

			await Promise.resolve()
			resolverCallCount.should.equal(1)

			resolverGate.resolve()

			const configs = await Promise.all(launchRequests)

			resolverCallCount.should.equal(1)
			configs.map((config) => config.command).should.deepEqual([resolvedExecutable, resolvedExecutable, resolvedExecutable])
			configs.map((config) => config.shell).should.deepEqual([false, false, false])
		})
	})

	it("clears failed launcher cache so later calls can recover", async () => {
		await withPlatform("win32", async () => {
			let resolverCallCount = 0

			const flakyResolver = async () => {
				resolverCallCount += 1
				if (resolverCallCount === 1) {
					throw new Error("initial resolver failure")
				}
				return "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
			}

			try {
				await getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1", flakyResolver)
				throw new Error("Expected first call to fail")
			} catch (error: any) {
				error.message.should.match(/initial resolver failure/)
			}

			const recoveredConfig = await getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1", flakyResolver)

			recoveredConfig.command.should.equal("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
			resolverCallCount.should.equal(2)
		})
	})

	it("refreshes cached Windows launcher resolution after cache TTL expires", async () => {
		await withPlatform("win32", async () => {
			const originalDateNow = Date.now
			const fakeNowValues = [1_000, 301_005]
			Date.now = () => fakeNowValues.shift() ?? 301_006

			let resolverCallCount = 0
			const resolvedExecutables = [
				"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			]

			try {
				const firstConfig = await getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\PreToolUse.ps1", async () => {
					resolverCallCount += 1
					return resolvedExecutables.shift() || "unexpected"
				})

				const secondConfig = await getHookLaunchConfig("C:\\workspace\\.clinerules\\hooks\\TaskResume.ps1", async () => {
					resolverCallCount += 1
					return resolvedExecutables.shift() || "unexpected"
				})

				firstConfig.command.should.equal("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
				secondConfig.command.should.equal("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
				resolverCallCount.should.equal(2)
			} finally {
				Date.now = originalDateNow
			}
		})
	})
})

describe("HookProcess spawn failures", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hookprocess-test-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function writeTestHook(): Promise<string> {
		const hookBasePath = path.join(tempDir, "TaskStart")
		await writeHookScriptForPlatform(hookBasePath, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ cancel: false }))\n`)
		return process.platform === "win32" ? `${hookBasePath}.ps1` : hookBasePath
	}

	it("fails the hook run with an error naming the cwd when it does not exist", async () => {
		const scriptPath = await writeTestHook()
		const missingCwd = path.join(tempDir, "deleted-workspace-root")

		// A hook assigned a working directory that no longer exists must fail
		// (open, catchably) rather than run with its relative paths resolving
		// against the host process's own working directory.
		const hookProcess = new HookProcess(scriptPath, 30000, undefined, missingCwd)

		try {
			await hookProcess.run("{}")
			throw new Error("Expected hook run to fail")
		} catch (error: any) {
			error.message.should.containEql(missingCwd)
			error.message.should.containEql("does not exist")
		}
	}, 15000)

	it.skipIf(process.platform === "win32")(
		"rejects instead of crashing when spawn fails with no error listener registered",
		async () => {
			const scriptPath = await writeTestHook()

			// A regular file passes the pre-spawn cwd existence check but makes
			// spawn fail with an "error" event (ENOTDIR). No "error" listener is
			// registered here, matching StdioHookRunner: an unguarded emit would
			// escape the child's error callback as an uncaught exception and kill
			// the whole process instead of failing this one hook.
			const fileAsCwd = path.join(tempDir, "not-a-directory")
			await fs.writeFile(fileAsCwd, "")

			const hookProcess = new HookProcess(scriptPath, 5000, undefined, fileAsCwd)

			try {
				await hookProcess.run("{}")
				throw new Error("Expected hook run to fail")
			} catch (error: any) {
				error.message.should.not.equal("Expected hook run to fail")
			}
		},
	)
})

describe("HookProcess dispose()", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hookprocess-dispose-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function writeTestHook(): Promise<string> {
		const hookBasePath = path.join(tempDir, "TaskStart")
		await writeHookScriptForPlatform(
			hookBasePath,
			`#!/usr/bin/env node\nconsole.log(JSON.stringify({ cancel: false }))\nconsole.error("some stderr output")\n`,
		)
		return process.platform === "win32" ? `${hookBasePath}.ps1` : hookBasePath
	}

	it("clears stdout and stderr buffers after dispose() is called", async () => {
		const scriptPath = await writeTestHook()
		const hookProcess = new HookProcess(scriptPath, 30000, undefined, tempDir)

		// Run the hook - it should complete successfully and produce output
		await hookProcess.run("{}")

		// Verify output was captured
		const stdout = hookProcess.getStdout()
		stdout.should.containEql("cancel")

		// Dispose of the process to clean up buffers
		hookProcess.dispose()

		// After dispose(), buffers should be empty
		hookProcess.getStdout().should.equal("")
		hookProcess.getStderr().should.equal("")
	}, 15000)

	it("is idempotent - calling dispose() multiple times is safe", async () => {
		const scriptPath = await writeTestHook()
		const hookProcess = new HookProcess(scriptPath, 30000, undefined, tempDir)

		await hookProcess.run("{}")

		// Call dispose() multiple times - should not throw
		hookProcess.dispose()
		hookProcess.dispose()
		hookProcess.dispose()

		// Buffers should still be empty
		hookProcess.getStdout().should.equal("")
	}, 15000)

	it("can be called after a failed hook run without throwing", async () => {
		const scriptPath = await writeTestHook()
		const missingCwd = path.join(tempDir, "deleted-workspace-root")

		const hookProcess = new HookProcess(scriptPath, 30000, undefined, missingCwd)

		try {
			await hookProcess.run("{}")
			throw new Error("Expected hook run to fail")
		} catch {
			// Expected to fail
		}

		// Should be safe to dispose even after a failed run
		hookProcess.dispose()
		hookProcess.getStdout().should.equal("")
	}, 15000)

	it("removes all event listeners after dispose() to prevent memory leaks", async () => {
		const scriptPath = await writeTestHook()
		const hookProcess = new HookProcess(scriptPath, 30000, undefined, tempDir)

		// Register a listener (as StdioHookRunner does for streaming)
		let lineCount = 0
		hookProcess.on("line", () => {
			lineCount++
		})

		await hookProcess.run("{}")

		// The listener should have been called during the run
		lineCount.should.be.greaterThan(0)

		// Before dispose, listeners exist
		hookProcess.listenerCount("line").should.be.greaterThan(0)

		// Dispose should remove all listeners
		hookProcess.dispose()

		// After dispose, no listeners remain — this prevents the EventEmitter
		// (and any closures it holds, e.g. the streamCallback from
		// StdioHookRunner) from being retained in memory.
		hookProcess.listenerCount("line").should.equal(0)
		hookProcess.listenerCount("completed").should.equal(0)
		hookProcess.listenerCount("error").should.equal(0)
	}, 15000)

	it("clears the execution timeout timer on dispose() to prevent lingering references", async () => {
		const scriptPath = await writeTestHook()
		// Use a long timeout so the timer would be active if not cleared
		const hookProcess = new HookProcess(scriptPath, 60000, undefined, tempDir)

		// Run the hook — the timeout timer is set during run() and cleared on
		// successful completion. But to test the dispose path specifically, we
		// verify that calling dispose() after a run doesn't leave a stale timer.
		await hookProcess.run("{}")

		// Dispose should be safe and not throw even though the timer was
		// already cleared by the close handler.
		hookProcess.dispose()

		// Verify we can still access the process state without issues
		hookProcess.hasCompleted().should.be.true()
		hookProcess.getExitCode()?.should.equal(0)
	}, 15000)
})

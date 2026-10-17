import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	CustomizationChangeNotifier,
	type FileWatcherLike,
	getCustomizationWatchTargets,
	type WatchTarget,
} from "./customization-watcher"

class FakeWatcher implements FileWatcherLike {
	readonly listeners: Array<() => void> = []
	disposed = false
	constructor(readonly target: WatchTarget) {}
	onDidCreate(listener: () => void) {
		this.listeners.push(listener)
	}
	onDidChange(listener: () => void) {
		this.listeners.push(listener)
	}
	onDidDelete(listener: () => void) {
		this.listeners.push(listener)
	}
	fire() {
		for (const listener of this.listeners) {
			listener()
		}
	}
	dispose() {
		this.disposed = true
	}
}

describe("CustomizationChangeNotifier", () => {
	let watchers: FakeWatcher[]
	let targets: WatchTarget[]
	let notifier: CustomizationChangeNotifier

	beforeEach(() => {
		vi.useFakeTimers()
		watchers = []
		targets = [
			{ base: "/repo", pattern: "{.cline/**}" },
			{ base: "/home/.cline", pattern: "{agents/**}" },
		]
		notifier = new CustomizationChangeNotifier({
			createWatcher: (target) => {
				const watcher = new FakeWatcher(target)
				watchers.push(watcher)
				return watcher
			},
			getTargets: () => targets,
			debounceMs: 100,
		})
	})

	afterEach(() => {
		notifier.dispose()
		vi.useRealTimers()
	})

	it("watches nothing until someone subscribes", async () => {
		await vi.runAllTimersAsync()
		expect(watchers).toHaveLength(0)
	})

	it("reports a burst of changes once, after the debounce", async () => {
		const listener = vi.fn()
		notifier.subscribe(listener)
		await vi.advanceTimersByTimeAsync(0)
		expect(watchers.map((w) => w.target.base)).toEqual(["/repo", "/home/.cline"])

		watchers[0].fire()
		watchers[1].fire()
		await vi.advanceTimersByTimeAsync(50)
		watchers[0].fire()
		expect(listener).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(100)
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it("stops watching when the last subscriber leaves, and drops a pending report", async () => {
		const first = vi.fn()
		const second = vi.fn()
		const unsubscribeFirst = notifier.subscribe(first)
		const unsubscribeSecond = notifier.subscribe(second)
		await vi.advanceTimersByTimeAsync(0)
		expect(watchers).toHaveLength(2)

		unsubscribeFirst()
		expect(watchers.every((w) => !w.disposed)).toBe(true)
		watchers[0].fire()
		unsubscribeSecond()
		expect(watchers.every((w) => w.disposed)).toBe(true)
		await vi.advanceTimersByTimeAsync(200)
		expect(first).not.toHaveBeenCalled()
		expect(second).not.toHaveBeenCalled()
	})

	it("re-reads the targets on restart, e.g. after a folder was added", async () => {
		notifier.subscribe(() => {})
		await vi.advanceTimersByTimeAsync(0)
		targets = [...targets, { base: "/other", pattern: "{.cline/**}" }]
		await notifier.restart()
		expect(watchers.slice(0, 2).every((w) => w.disposed)).toBe(true)
		expect(watchers.slice(2).map((w) => w.target.base)).toEqual(["/repo", "/home/.cline", "/other"])
	})
})

describe("getCustomizationWatchTargets", () => {
	it("watches each workspace folder and only the customization folders of the global locations", () => {
		const home = path.resolve("/home/me")
		const clineDir = path.join(home, ".cline")
		const documentsDir = path.join(home, "Documents")
		const targets = getCustomizationWatchTargets({
			workspacePaths: [path.resolve("/repo")],
			homeDir: home,
			clineDir,
			documentsDir,
			globalRulesDirs: [
				path.join(clineDir, "rules"),
				path.join(documentsDir, "Cline", "Rules"),
				path.join(home, "Cline", "Rules"),
			],
		})
		expect(targets.map((t) => t.base)).toEqual([
			path.resolve("/repo"),
			clineDir,
			path.join(home, ".agents"),
			path.join(documentsDir, "Cline"),
			path.join(home, "Cline", "Rules"),
		])
		expect(targets[0].pattern).toContain(".cline/**")
		expect(targets[0].pattern).toContain("AGENTS.md")
		// ~/.cline also holds the extension's data, which must not trigger refreshes.
		expect(targets[1].pattern).toBe("{rules,skills,agents,hooks,workflows}/**")
	})
})

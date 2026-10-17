import path from "path"

/**
 * Tells the Rules panel when a rules, skills, hooks or agents file changes,
 * so it refreshes then instead of rescanning the disk every second. File
 * watchers exist only while someone listens: the panel subscribes when it
 * opens and unsubscribes when it closes.
 */

/** A folder to watch and the glob, relative to it, of the files that matter. */
export interface WatchTarget {
	base: string
	pattern: string
}

/** The part of a VS Code `FileSystemWatcher` this module uses. */
export interface FileWatcherLike {
	onDidCreate(listener: () => void): unknown
	onDidChange(listener: () => void): unknown
	onDidDelete(listener: () => void): unknown
	dispose(): void
}

type CreateFileWatcher = (target: WatchTarget) => FileWatcherLike | undefined

/**
 * Workspace files that feed the panel: rules (`.clinerules`, `.cline/rules`,
 * `AGENTS.md`, `CLAUDE.md`, Copilot, Cursor and Windsurf rules), skills
 * (`.cline`, `.agents`, `.github`, `.cursor`, `.claude`), hooks
 * (`.clinerules/hooks`, `.cline/hooks`) and agents (`.cline/agents`).
 */
const WORKSPACE_PATTERN =
	"{.clinerules/**,.cline/**,.agents/**,.github/skills/**,.github/instructions/**,.github/copilot-instructions.md,.cursor/rules/**,.cursor/skills/**,.claude/skills/**,.cursorrules,.windsurfrules,AGENTS.md,CLAUDE.md}"

interface WatchTargetInput {
	workspacePaths: string[]
	homeDir: string
	/** `~/.cline`, or `CLINE_DIR`: global rules, skills, agents and hooks. */
	clineDir: string
	/** The user's Documents folder, which holds `Cline/Rules`, `Cline/Hooks` and `Cline/Workflows`. */
	documentsDir: string
	/** Every folder the engine reads global rules from. */
	globalRulesDirs: string[]
}

export function getCustomizationWatchTargets(input: WatchTargetInput): WatchTarget[] {
	const targets: WatchTarget[] = [
		...input.workspacePaths.map((base) => ({ base, pattern: WORKSPACE_PATTERN })),
		// Only these folders: ~/.cline also holds the extension's data, which changes all the time.
		{ base: input.clineDir, pattern: "{rules,skills,agents,hooks,workflows}/**" },
		{ base: path.join(input.homeDir, ".agents"), pattern: "{skills/**,AGENTS.md}" },
		{ base: path.join(input.documentsDir, "Cline"), pattern: "{Rules,Hooks,Workflows}/**" },
	]
	// Global rules folders the targets above do not cover yet (e.g. ~/Cline/Rules on WSL).
	const key = (dir: string) => (process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir))
	const seen = new Set([path.join(input.clineDir, "rules"), path.join(input.documentsDir, "Cline", "Rules")].map(key))
	for (const dir of input.globalRulesDirs) {
		if (!seen.has(key(dir))) {
			seen.add(key(dir))
			targets.push({ base: dir, pattern: "**" })
		}
	}
	return targets
}

interface NotifierOptions {
	createWatcher: CreateFileWatcher
	getTargets: () => Promise<WatchTarget[]> | WatchTarget[]
	/** Changes closer together than this are reported once (an editor's save is several events). */
	debounceMs?: number
	onError?: (error: unknown) => void
}

const DEFAULT_DEBOUNCE_MS = 300

export class CustomizationChangeNotifier {
	private readonly listeners = new Set<() => void>()
	private watchers: FileWatcherLike[] = []
	private timer: ReturnType<typeof setTimeout> | undefined
	/** Bumped on every start and stop, so a start that finishes late drops its watchers. */
	private generation = 0

	constructor(private readonly options: NotifierOptions) {}

	/** Calls `listener` after each burst of changes until the returned function is called. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		if (this.listeners.size === 1) {
			void this.start()
		}
		return () => {
			if (this.listeners.delete(listener) && this.listeners.size === 0) {
				this.stop()
			}
		}
	}

	/** Re-reads the targets, e.g. after a workspace folder was added. */
	async restart(): Promise<void> {
		if (this.listeners.size === 0) {
			return
		}
		this.stop()
		await this.start()
	}

	dispose(): void {
		this.listeners.clear()
		this.stop()
	}

	private async start(): Promise<void> {
		const generation = ++this.generation
		let targets: WatchTarget[]
		try {
			targets = await this.options.getTargets()
		} catch (error) {
			this.options.onError?.(error)
			return
		}
		if (generation !== this.generation || this.listeners.size === 0) {
			return
		}
		const schedule = () => this.schedule()
		for (const target of targets) {
			try {
				const watcher = this.options.createWatcher(target)
				if (!watcher) {
					continue
				}
				watcher.onDidCreate(schedule)
				watcher.onDidChange(schedule)
				watcher.onDidDelete(schedule)
				this.watchers.push(watcher)
			} catch (error) {
				this.options.onError?.(error)
			}
		}
	}

	private stop(): void {
		this.generation++
		if (this.timer !== undefined) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
		for (const watcher of this.watchers) {
			try {
				watcher.dispose()
			} catch {
				// Already gone.
			}
		}
		this.watchers = []
	}

	private schedule(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer)
		}
		this.timer = setTimeout(() => {
			this.timer = undefined
			for (const listener of [...this.listeners]) {
				try {
					listener()
				} catch (error) {
					this.options.onError?.(error)
				}
			}
		}, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
	}
}

let notifier: CustomizationChangeNotifier | undefined

/** Set once by the host at activation (hosts/vscode/customization-watcher.ts). */
export function setCustomizationChangeNotifier(next: CustomizationChangeNotifier | undefined): void {
	notifier?.dispose()
	notifier = next
}

export function getCustomizationChangeNotifier(): CustomizationChangeNotifier | undefined {
	return notifier
}

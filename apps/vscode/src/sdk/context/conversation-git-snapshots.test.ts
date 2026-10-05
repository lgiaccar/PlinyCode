import type { GitSnapshot } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import { ConversationGitSnapshots, GIT_SNAPSHOT_METADATA_KEY, parseStoredGitSnapshot } from "./conversation-git-snapshots"

const SNAPSHOT: GitSnapshot = {
	branch: "feature/env",
	defaultBranch: "main",
	status: [" M src/app.ts"],
	recentCommits: ["abc1234 Add the env block"],
}

function gatherMock() {
	return vi.fn(async (_cwd: string): Promise<GitSnapshot | undefined> => SNAPSHOT)
}

function makeSnapshots(overrides: Partial<ConstructorParameters<typeof ConversationGitSnapshots>[0]> = {}) {
	const options = {
		isEnabled: vi.fn(() => true),
		gather: gatherMock(),
		readStored: vi.fn(async (_conversationId: string): Promise<unknown> => undefined),
		...overrides,
	}
	return { snapshots: new ConversationGitSnapshots(options), options }
}

describe("ConversationGitSnapshots", () => {
	it("gathers a snapshot once, when the conversation starts, and reuses it on every rebuild", async () => {
		const gather = gatherMock()
		const { snapshots, options } = makeSnapshots({ gather })

		// New task: no conversation yet.
		const first = await snapshots.prepare(undefined, "/repo")
		first.bindToSession("task-1")
		expect(first.snapshot).toEqual(SNAPSHOT)
		expect(gather).toHaveBeenCalledWith("/repo")

		// The repository moves on; mode switches and MCP rebuilds must not see it.
		gather.mockResolvedValue({ branch: "another-branch" })
		for (let rebuild = 0; rebuild < 3; rebuild += 1) {
			const again = await snapshots.prepare("task-1", "/repo")
			again.bindToSession("task-1")
			expect(again.snapshot).toEqual(SNAPSHOT)
		}

		expect(gather).toHaveBeenCalledTimes(1)
		expect(options.readStored).not.toHaveBeenCalled()
		expect(snapshots.sessionMetadata("task-1")).toEqual({ [GIT_SNAPSHOT_METADATA_KEY]: SNAPSHOT })
	})

	it("gathers separately for each new conversation", async () => {
		const gather = gatherMock()
		const { snapshots } = makeSnapshots({ gather })

		;(await snapshots.prepare(undefined, "/repo")).bindToSession("task-1")
		gather.mockResolvedValue({ branch: "later" })
		const second = await snapshots.prepare(undefined, "/repo")
		second.bindToSession("task-2")

		expect(second.snapshot).toEqual({ branch: "later" })
		expect((await snapshots.prepare("task-1", "/repo")).snapshot).toEqual(SNAPSHOT)
		expect(gather).toHaveBeenCalledTimes(2)
	})

	it("reads the snapshot stored with the session record when a conversation is resumed", async () => {
		// A new window, or the same one after a restart: nothing in memory.
		const { snapshots, options } = makeSnapshots({ readStored: vi.fn(async () => ({ ...SNAPSHOT })) })

		const resumed = await snapshots.prepare("task-1", "/repo")
		resumed.bindToSession("task-1")
		await snapshots.prepare("task-1", "/repo")

		expect(resumed.snapshot).toEqual(SNAPSHOT)
		expect(options.readStored).toHaveBeenCalledTimes(1)
		expect(options.readStored).toHaveBeenCalledWith("task-1")
		expect(options.gather).not.toHaveBeenCalled()
		expect(snapshots.sessionMetadata("task-1")).toEqual({ [GIT_SNAPSHOT_METADATA_KEY]: SNAPSHOT })
	})

	it("never gathers for a conversation that started without a snapshot", async () => {
		// Begun outside a repository, with the setting off, or before the feature existed.
		const { snapshots, options } = makeSnapshots()

		const resumed = await snapshots.prepare("old-task", "/repo")
		resumed.bindToSession("old-task")
		const rebuilt = await snapshots.prepare("old-task", "/repo")

		expect(resumed.snapshot).toBeUndefined()
		expect(rebuilt.snapshot).toBeUndefined()
		expect(options.gather).not.toHaveBeenCalled()
		expect(options.readStored).toHaveBeenCalledTimes(1)
		expect(snapshots.sessionMetadata("old-task")).toBeUndefined()
	})

	it("remembers that a workspace is not a repository instead of asking git again", async () => {
		const { snapshots, options } = makeSnapshots({ gather: vi.fn(async () => undefined) })

		const first = await snapshots.prepare(undefined, "/plain-folder")
		first.bindToSession("task-1")
		const rebuilt = await snapshots.prepare("task-1", "/plain-folder")

		expect(first.snapshot).toBeUndefined()
		expect(rebuilt.snapshot).toBeUndefined()
		expect(options.gather).toHaveBeenCalledTimes(1)
		expect(options.readStored).not.toHaveBeenCalled()
	})

	it("carries the snapshot to the new session when a conversation continues under another id", async () => {
		// Editing a message or restoring a checkpoint starts a session with a new id.
		const { snapshots, options } = makeSnapshots()
		;(await snapshots.prepare(undefined, "/repo")).bindToSession("task-1")

		const regenerated = await snapshots.prepare("task-1", "/repo")
		regenerated.bindToSession("task-2")

		expect(regenerated.snapshot).toEqual(SNAPSHOT)
		expect(snapshots.sessionMetadata("task-2")).toEqual({ [GIT_SNAPSHOT_METADATA_KEY]: SNAPSHOT })
		expect((await snapshots.prepare("task-2", "/repo")).snapshot).toEqual(SNAPSHOT)
		expect(options.gather).toHaveBeenCalledTimes(1)
	})

	describe("with plinycode.context.gitSnapshot off", () => {
		it("does not run git for a new conversation, and does not start later", async () => {
			const isEnabled = vi.fn(() => false)
			const { snapshots, options } = makeSnapshots({ isEnabled })

			const first = await snapshots.prepare(undefined, "/repo")
			first.bindToSession("task-1")
			expect(first.snapshot).toBeUndefined()

			// Turned on mid-conversation: the conversation started without one.
			isEnabled.mockReturnValue(true)
			expect((await snapshots.prepare("task-1", "/repo")).snapshot).toBeUndefined()
			expect(options.gather).not.toHaveBeenCalled()
		})

		it("hides a conversation's snapshot without discarding it", async () => {
			const isEnabled = vi.fn(() => true)
			const { snapshots } = makeSnapshots({ isEnabled })
			;(await snapshots.prepare(undefined, "/repo")).bindToSession("task-1")

			isEnabled.mockReturnValue(false)
			const hidden = await snapshots.prepare("task-1", "/repo")
			hidden.bindToSession("task-1")
			expect(hidden.snapshot).toBeUndefined()
			// Still stored with the session, so it comes back with the setting.
			expect(snapshots.sessionMetadata("task-1")).toEqual({ [GIT_SNAPSHOT_METADATA_KEY]: SNAPSHOT })

			isEnabled.mockReturnValue(true)
			expect((await snapshots.prepare("task-1", "/repo")).snapshot).toEqual(SNAPSHOT)
		})
	})

	it("builds without a snapshot when gathering or reading fails", async () => {
		const failing = makeSnapshots({
			gather: vi.fn(async () => {
				throw new Error("spawn failed")
			}),
		})
		expect((await failing.snapshots.prepare(undefined, "/repo")).snapshot).toBeUndefined()

		const readStored = vi
			.fn<(conversationId: string) => Promise<unknown>>()
			.mockRejectedValueOnce(new Error("database is locked"))
		const { snapshots } = makeSnapshots({ readStored })
		expect((await snapshots.prepare("task-1", "/repo")).snapshot).toBeUndefined()
		// A failed read is not remembered as "no snapshot": the next build asks again.
		readStored.mockResolvedValue({ ...SNAPSHOT })
		expect((await snapshots.prepare("task-1", "/repo")).snapshot).toEqual(SNAPSHOT)
	})
})

describe("parseStoredGitSnapshot", () => {
	it("round-trips a snapshot through session metadata", () => {
		const full: GitSnapshot = { ...SNAPSHOT, head: "abc1234", statusOmitted: 4, statusIncomplete: true }
		expect(parseStoredGitSnapshot(JSON.parse(JSON.stringify(full)))).toEqual(full)
	})

	it("drops anything that is not a snapshot", () => {
		expect(parseStoredGitSnapshot(undefined)).toBeUndefined()
		expect(parseStoredGitSnapshot("main")).toBeUndefined()
		expect(parseStoredGitSnapshot([])).toBeUndefined()
		expect(parseStoredGitSnapshot({})).toBeUndefined()
		expect(parseStoredGitSnapshot({ branch: 7, status: ["ok", 3], recentCommits: "abc" })).toBeUndefined()
		expect(parseStoredGitSnapshot({ branch: "main", status: [1], statusOmitted: -2 })).toEqual({ branch: "main" })
	})
})

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionPersistenceAdapter } from "../../types/session";
import type { SessionRow } from "../models/session-row";
import { SessionManifestStore } from "./session-manifest-store";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "plinycode-manifest-store-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function row(sessionId: string, messagesPath: string): SessionRow {
	return {
		sessionId,
		source: "test",
		pid: process.pid,
		startedAt: "2026-10-09T00:00:00.000Z",
		status: "running",
		statusLock: 0,
		interactive: true,
		provider: "pliny",
		model: "m",
		cwd: root,
		workspaceRoot: root,
		enableTools: true,
		enableSpawn: false,
		enableTeams: false,
		isSubagent: false,
		messagesPath,
		updatedAt: "2026-10-09T00:00:00.000Z",
	} as SessionRow;
}

function makeStore(rows: SessionRow[]): SessionManifestStore {
	const byId = new Map(rows.map((r) => [r.sessionId, r]));
	const adapter = {
		ensureSessionsDir: () => root,
		getSession: async (sessionId: string) => byId.get(sessionId),
		upsertSession: async () => {},
	} as unknown as SessionPersistenceAdapter;
	return new SessionManifestStore(adapter);
}

function message(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
	};
}

describe("SessionManifestStore.persistSessionMessages", () => {
	it("writes a compact, parseable transcript and leaves no temp file behind", async () => {
		const path = join(root, "s1", "s1.messages.json");
		const store = makeStore([row("s1", path)]);

		await store.persistSessionMessages(
			"s1",
			[message("hello")] as never,
			"sys",
		);

		const raw = await readFile(path, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw.split("\n")).toHaveLength(2);
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(1);
		expect(parsed.system_prompt).toBe("sys");
		expect(parsed.messages[0].content[0].text).toBe("hello");
		expect(await readdir(join(root, "s1"))).toEqual(["s1.messages.json"]);
	});

	it("coalesces writes requested while one is in flight, keeping the newest", async () => {
		const path = join(root, "s2", "s2.messages.json");
		const store = makeStore([row("s2", path)]);

		const writes = Array.from({ length: 6 }, (_, index) =>
			store.persistSessionMessages("s2", [message(`turn ${index}`)] as never),
		);
		await Promise.all(writes);

		const parsed = JSON.parse(await readFile(path, "utf8"));
		expect(parsed.messages[0].content[0].text).toBe("turn 5");
		expect(await readdir(join(root, "s2"))).toEqual(["s2.messages.json"]);
	});

	it("keeps sessions apart", async () => {
		const a = join(root, "a", "a.messages.json");
		const b = join(root, "b", "b.messages.json");
		const store = makeStore([row("a", a), row("b", b)]);

		await Promise.all([
			store.persistSessionMessages("a", [message("for a")] as never),
			store.persistSessionMessages("b", [message("for b")] as never),
		]);

		expect(
			JSON.parse(await readFile(a, "utf8")).messages[0].content[0].text,
		).toBe("for a");
		expect(
			JSON.parse(await readFile(b, "utf8")).messages[0].content[0].text,
		).toBe("for b");
	});
});

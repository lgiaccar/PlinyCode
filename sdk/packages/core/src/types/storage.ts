import type { SessionStatus } from "./common";
import type { SessionRecord } from "./sessions";

export interface SessionStore {
	init(): Promise<void> | void;
	create(record: SessionRecord): Promise<void> | void;
	updateStatus(
		sessionId: string,
		status: SessionStatus,
		exitCode?: number | null,
	): Promise<void> | void;
	update(
		record: Partial<SessionRecord> & { sessionId: string },
	): Promise<void> | void;
	get(
		sessionId: string,
	): Promise<SessionRecord | undefined> | SessionRecord | undefined;
	list(limit?: number): Promise<SessionRecord[]> | SessionRecord[];
	delete(sessionId: string, cascade?: boolean): Promise<boolean> | boolean;
}

export interface ArtifactStore {
	appendHook(sessionId: string, payload: unknown): Promise<void> | void;
	writeMessages(sessionId: string, messages: unknown[]): Promise<void> | void;
}

import type { HookEventPayload } from "../../hooks";
import type { SessionStatus } from "../../types/common";

export function sanitizeSessionToken(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function makeSubSessionId(
	rootSessionId: string,
	agentId: string,
): string {
	const root = sanitizeSessionToken(rootSessionId);
	const agent = sanitizeSessionToken(agentId);
	const joined = `${root}__${agent}`;
	return joined.length > 180 ? joined.slice(0, 180) : joined;
}

export function parseSubSessionId(
	sessionId: string,
): { rootSessionId: string; agentId: string } | null {
	const separator = "__";
	const separatorIndex = sessionId.indexOf(separator);
	if (separatorIndex <= 0) {
		return null;
	}
	const rootSessionId = sessionId.slice(0, separatorIndex);
	const agentId = sessionId.slice(separatorIndex + separator.length);
	if (!rootSessionId || !agentId) {
		return null;
	}
	return { rootSessionId, agentId };
}

export function deriveSubsessionStatus(event: HookEventPayload): SessionStatus {
	switch (event.hookName) {
		case "agent_end":
			return "completed";
		case "agent_error":
			return "failed";
		case "session_shutdown": {
			const reason = String(event.reason ?? "").toLowerCase();
			if (
				reason.includes("cancel") ||
				reason.includes("abort") ||
				reason.includes("interrupt")
			) {
				return "cancelled";
			}
			if (reason.includes("fail") || reason.includes("error")) {
				return "failed";
			}
			return "completed";
		}
		default:
			return "running";
	}
}

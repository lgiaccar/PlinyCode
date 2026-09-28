/**
 * The stateless agent loop: `AgentRuntime` (also exported as `Agent`) runs
 * and continues tool-using conversations against an `AgentModel`. It holds no
 * session, storage or config state; `SessionRuntime` in
 * `runtime/orchestration` owns that and drives this loop.
 *
 * Shared types (`AgentMessage`, `AgentRunResult`, etc.) come from
 * `@plinycode/shared`.
 */

export { AgentRuntimeAbortError } from "./agent-errors";
export type { AgentRunInput } from "./agent-messages";
export type { AgentEventListener } from "./agent-runtime";
export {
	Agent,
	AgentRuntime,
	createAgent,
	createAgentRuntime,
} from "./agent-runtime";
export type {
	AgentRuntimeConfig,
	AgentRuntimeConfigWithModel,
	AgentRuntimeConfigWithProvider,
} from "./runtime-config";

import {
	isPlinySelfHostedModelId,
	type ModelInfo,
	plinyThinkingControls,
} from "@plinycode/llms";
import {
	type AgentModelFactory,
	estimateRequestInputTokens,
} from "@plinycode/shared";
import { createRoutedAgentModel } from "./routed-agent-model";
import { defaultRules } from "./router-defaults";

function containsImage(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsImage);
	if (!value || typeof value !== "object") return false;
	if ("type" in value && value.type === "image") return true;
	return Object.values(value).some(containsImage);
}

export interface FreeAutoEvent {
	kind: "start" | "failover" | "success" | "error";
	modelId: string;
	nextModelId?: string;
	route?: string;
	error?: string;
}

/** Default FreeAuto routing for standalone hosts, with no editor state or file I/O.
 * Health persists for the host's lifetime; sticky choices reset for each run.
 * After partial output, fail the run instead of replaying completed tool work.
 */
export function createFreeAutoModelFactory(options: {
	knownModels: Record<string, ModelInfo>;
	/** Avoid a model that already failed a host's output validation. */
	excludedModels?: string[];
	onEvent?: (event: FreeAutoEvent) => void;
	logWarning?: (message: string) => void;
}): AgentModelFactory {
	const health = new Map<string, { failures: number; until: number }>();
	return ({ createDefault }) => {
		const rules = defaultRules();
		// An additional boundary: standalone FreeAuto never delegates to paid or
		// unknown models, even if defaults or the catalog change independently.
		rules.pool = rules.pool.filter(
			(id) =>
				isPlinySelfHostedModelId(id) &&
				!!options.knownModels[id] &&
				!options.excludedModels?.includes(id),
		);
		let stickyModelId: string | undefined;
		let calls = 0;
		let failovers = 0;
		const fail = (modelId: string) => {
			const failures = (health.get(modelId)?.failures ?? 0) + 1;
			health.set(modelId, {
				failures,
				until:
					failures >= rules.health.failuresBeforeCooldown
						? Date.now() + rules.health.cooldownMs
						: 0,
			});
		};
		return createRoutedAgentModel({
			retryPartialOutput: false,
			rules: () => rules,
			knownModels: () => options.knownModels,
			isHealthy: (id) => (health.get(id)?.until ?? 0) <= Date.now(),
			createDelegate: (modelId) => {
				if (!rules.pool.includes(modelId))
					throw new Error("FreeAuto rejected a model outside its free pool.");
				return createDefault({ modelId });
			},
			canAttempt: () => failovers <= rules.health.maxFailoversPerTurn,
			thinkingControls: plinyThinkingControls,
			logWarning: options.logWarning,
			features: (request) => ({
				estimatedTokens: estimateRequestInputTokens(request),
				mode: "act",
				prompt:
					[...request.messages]
						.reverse()
						.find((message) => message.role === "user")
						?.content.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n") ?? "",
				hasImages: request.messages.some((message) =>
					message.content.some(
						(part) =>
							part.type === "image" ||
							(part.type === "tool-result" && containsImage(part.output)),
					),
				),
				isSubAgent: false,
				callIndex: ++calls,
				stickyModelId,
			}),
			observer: {
				onCallStart: ({ modelId, decision }) =>
					options.onEvent?.({
						kind: "start",
						modelId,
						route: decision.routeName,
					}),
				onCallSuccess: ({ modelId }) => {
					health.delete(modelId);
					stickyModelId = modelId;
					options.onEvent?.({ kind: "success", modelId });
				},
				onFailover: ({ modelId, nextModelId, error }) => {
					failovers++;
					fail(modelId);
					if (stickyModelId === modelId) stickyModelId = undefined;
					options.onEvent?.({
						kind: "failover",
						modelId,
						nextModelId:
							failovers <= rules.health.maxFailoversPerTurn
								? nextModelId
								: undefined,
						error,
					});
				},
				onCallError: ({ modelId, error }) =>
					options.onEvent?.({ kind: "error", modelId, error }),
			},
		});
	};
}

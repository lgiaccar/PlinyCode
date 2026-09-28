import type {
	AgentConfig,
	AgentExtensionRule,
	AgentFinishReason,
	AgentRunResult,
	AgentTool,
	BasicLogger,
	Message,
	ModelInfo,
} from "@plinycode/shared";
import { filterDisabledTools } from "../../services/global-settings";
import { resolveKnownModelsFromConfig } from "../../services/llms/handler-factory";

export function formatToolResultError(output: unknown): string {
	if (typeof output === "string") {
		return output;
	}
	if (output instanceof Error) {
		return output.message;
	}
	try {
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}

export async function resolveRuleContent(
	rule: AgentExtensionRule,
): Promise<string | undefined> {
	const content =
		typeof rule.content === "function" ? await rule.content() : rule.content;
	const trimmed = content.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function mergeSystemPromptRules(
	systemPrompt: string,
	rules: ReadonlyArray<string>,
): string {
	const base = systemPrompt.trim();
	const additional = rules
		.map((rule) => rule.trim())
		.filter(Boolean)
		.join("\n\n");
	if (base && additional) {
		return `${base}\n\n${additional}`;
	}
	return base || additional;
}

function isToolEnabledByPolicies(
	toolName: string,
	toolPolicies: AgentConfig["toolPolicies"],
): boolean {
	const globalPolicy = toolPolicies?.["*"] ?? {};
	const toolPolicy = toolPolicies?.[toolName] ?? {};
	return (
		{
			...globalPolicy,
			...toolPolicy,
		}.enabled !== false
	);
}

function filterToolsByPolicies(
	tools: AgentTool[],
	toolPolicies: AgentConfig["toolPolicies"],
): AgentTool[] {
	return tools.filter((tool) =>
		isToolEnabledByPolicies(tool.name, toolPolicies),
	);
}

export function filterAvailableExtensionTools(
	tools: AgentTool[],
	toolPolicies: AgentConfig["toolPolicies"],
): AgentTool[] {
	return filterDisabledTools(filterToolsByPolicies(tools, toolPolicies));
}

export function leveledLog(
	logger: BasicLogger | undefined,
	level: "debug" | "info" | "warn" | "error",
	message: string,
	metadata?: Record<string, unknown>,
): void {
	if (!logger) {
		return;
	}
	if (level === "debug") {
		logger.debug(message, metadata);
		return;
	}
	if (level === "error" && logger.error) {
		logger.error(message, metadata);
		return;
	}
	const severity: "info" | "warn" | "error" =
		level === "warn" ? "warn" : level === "error" ? "error" : "info";
	logger.log(message, { ...metadata, severity });
}

export function deriveFinishReason(
	runResult: AgentRunResult | undefined,
): AgentFinishReason {
	if (!runResult) {
		return "error";
	}
	switch (runResult.status) {
		case "completed":
			return "completed";
		case "aborted":
			return "aborted";
		case "failed":
			return "error";
	}
}

export async function buildUserTurnContent(
	userMessage: string,
	userImages: string[] | undefined,
	userFiles: string[] | undefined,
	loader: AgentConfig["userFileContentLoader"],
): Promise<Message["content"]> {
	// Import lazily to avoid a circular-import hazard via runtime barrels.
	const { buildInitialUserContent } = await import("./user-input-builder");
	return buildInitialUserContent(userMessage, userImages, userFiles, loader);
}

export function tryGetModelInfo(config: AgentConfig): ModelInfo | undefined {
	if (config.knownModels?.[config.modelId]) {
		return config.knownModels[config.modelId];
	}
	const resolvedKnownModels = resolveKnownModelsFromConfig(config);
	if (resolvedKnownModels?.[config.modelId]) {
		return resolvedKnownModels[config.modelId];
	}
	return undefined;
}

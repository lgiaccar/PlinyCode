import { buildClineSystemPrompt } from "@plinycode/shared";
import type { DelegatedAgentRuntimeConfig } from "./delegated-agent";

export function buildTeammateSystemPrompt(
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const trimmedPrompt = prompt.trim();
	if (config.providerId.toLowerCase() !== "cline") {
		return trimmedPrompt;
	}

	return buildClineSystemPrompt({
		ide: config.clineIdeName?.trim() || "Terminal",
		workspaceRoot: config.cwd?.trim() || "/",
		providerId: config.providerId,
		rules: `# Team Teammate Role\n${trimmedPrompt}`,
		platform: config.clinePlatform,
		metadata: config.workspaceMetadata,
	});
}

/**
 * What every sub-agent is told about its situation, whatever the parent
 * wrote. It goes in the rules slot of the base prompt, after the environment
 * block and before the parent's instructions.
 */
export const SUB_AGENT_ROLE_RULES = `# Delegated task
You are a sub-agent working for a parent agent inside the same conversation. You did not see that conversation: everything you know about the task is in the message you receive. Work on it independently and do not ask the user questions. Finish with a concise report for the parent: what you found or changed, the paths involved, and anything it must know (open problems, decisions it should make). Only your final message reaches the parent.`;

/**
 * The system prompt of a spawned sub-agent. The parent's instructions were
 * once the whole prompt: a sub-agent then ran with no environment block, no
 * working directory, no tool guidance and no conventions, however little the
 * parent model wrote. It now gets the same base prompt as a root session,
 * with the parent's instructions as rules under a short account of its role.
 * The Cline CLI provider keeps its own override shape.
 */
export function buildSubAgentSystemPrompt(
	// The prompt provided when spawning the subagent
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const trimmedPrompt = prompt.trim();
	if (config.providerId.toLowerCase() === "cline") {
		return buildClineSystemPrompt({
			ide: config.clineIdeName || "Terminal",
			workspaceRoot: config.cwd?.trim() || "/",
			providerId: config.providerId,
			overridePrompt: trimmedPrompt,
			metadata: config.workspaceMetadata,
			platform: config.clinePlatform,
		});
	}

	const rules = [
		SUB_AGENT_ROLE_RULES,
		trimmedPrompt ? `## Instructions from the parent\n${trimmedPrompt}` : "",
		config.promptSuffix?.trim() ?? "",
	]
		.filter(Boolean)
		.join("\n\n");
	return buildClineSystemPrompt({
		ide: config.clineIdeName?.trim() || "Terminal",
		workspaceRoot: config.cwd?.trim() || "/",
		providerId: config.providerId,
		mode: config.mode === "plan" || config.mode === "ask" ? "plan" : "act",
		planModeSwitchTool: false,
		rules,
		platform: config.clinePlatform,
		metadata: config.workspaceMetadata,
		gitSnapshot: config.gitSnapshot,
		currentDate: config.currentDate,
	});
}

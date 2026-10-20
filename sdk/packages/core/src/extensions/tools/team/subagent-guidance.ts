import type { AgentExtension } from "@plinycode/shared";

export const SUB_AGENT_GUIDANCE_RULE_ID = "subagents:guidance";

/**
 * What the root agent is told about delegating. The `spawn_agent` tool's
 * description says what the tool does; this says when to reach for it, and
 * goes in the system prompt only while the tool is in the request.
 */
export const SUB_AGENT_GUIDANCE = `## Delegating to sub-agents
Delegate with \`spawn_agent\` when the work would fill your context with output you do not need: exploring many files to answer a question, reviewing a change, running and reading a long test suite, or independent subtasks that can run in parallel. Keep single reads, single commands and small edits for yourself.`;

/** The extension that registers the guidance, gated on the tool being available. */
export function createSubAgentGuidanceExtension(): AgentExtension {
	return {
		name: "cline-subagent-guidance",
		manifest: { capabilities: ["rules"] },
		setup(api) {
			api.registerRule({
				id: SUB_AGENT_GUIDANCE_RULE_ID,
				source: "runtime",
				whenToolAvailable: "spawn_agent",
				content: SUB_AGENT_GUIDANCE,
			});
		},
	};
}

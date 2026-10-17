/**
 * The tool names configured agents get (`subagent_<name>`). Kept apart from
 * the tool itself, which pulls in the agent runtime, so a host can work out
 * an agent's tool name (for a tool policy, say) without loading it.
 */
import type { ConfiguredAgentConfig } from "./configured-agent-config";

const CONFIGURED_AGENT_TOOL_NAME_PREFIX = "subagent_";
const CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH = 64;

export interface ConfiguredAgentToolDescriptor {
	toolName: string;
	config: ConfiguredAgentConfig;
}

function sanitizeAgentName(name: string): string {
	let result = "";
	let lastWasUnderscore = true;

	for (const char of name.trim().toLowerCase()) {
		const code = char.charCodeAt(0);
		const isAllowed =
			(code >= 97 && code <= 122) || (code >= 48 && code <= 57) || char === "_";

		if (!isAllowed || char === "_") {
			if (!lastWasUnderscore) {
				result += "_";
				lastWasUnderscore = true;
			}
			continue;
		}

		result += char;
		lastWasUnderscore = false;
	}

	return lastWasUnderscore ? result.slice(0, -1) : result;
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export function buildConfiguredAgentToolName(agentName: string): string {
	const sanitized = sanitizeAgentName(agentName) || "agent";
	const hashSuffix = hashString(agentName).slice(0, 6);
	const base = `${CONFIGURED_AGENT_TOOL_NAME_PREFIX}${sanitized}`;

	if (base.length <= CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH) {
		return base;
	}

	const maxBodyLength =
		CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH -
		CONFIGURED_AGENT_TOOL_NAME_PREFIX.length -
		hashSuffix.length -
		1;
	const body = sanitized.slice(0, Math.max(1, maxBodyLength));
	return `${CONFIGURED_AGENT_TOOL_NAME_PREFIX}${body}_${hashSuffix}`.slice(
		0,
		CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH,
	);
}

export function buildConfiguredAgentToolDescriptors(
	agents: readonly ConfiguredAgentConfig[],
): ConfiguredAgentToolDescriptor[] {
	const usedToolNames = new Set<string>();
	const descriptors: ConfiguredAgentToolDescriptor[] = [];

	for (const config of [...agents].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const baseName = buildConfiguredAgentToolName(config.name);
		let candidate = baseName;
		let suffix = 2;
		while (usedToolNames.has(candidate)) {
			const suffixText = `_${suffix++}`;
			const maxBaseLength = Math.max(
				1,
				CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH - suffixText.length,
			);
			candidate = `${baseName.slice(0, maxBaseLength)}${suffixText}`;
		}
		usedToolNames.add(candidate);
		descriptors.push({ toolName: candidate, config });
	}

	return descriptors;
}

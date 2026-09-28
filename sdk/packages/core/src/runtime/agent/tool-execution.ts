import type {
	AgentAfterToolResult,
	AgentBeforeToolResult,
	AgentMessage,
	AgentMessagePart,
	AgentTool,
	AgentToolCallPart,
	AgentToolResult,
	AgentRuntimeConfig as BaseAgentRuntimeConfig,
	ToolApprovalResult,
	ToolPolicy,
} from "@plinycode/shared";
import {
	normalizeJsonLikeStringsForSchema,
	TOOL_REJECTION_SUFFIX,
} from "@plinycode/shared";
import type { AgentLoopContext } from "./agent-loop-context";
import { createMessage, createUID } from "./agent-messages";

function resolveToolPolicy(
	toolName: string,
	policies: BaseAgentRuntimeConfig["toolPolicies"],
): ToolPolicy {
	return {
		...(policies?.["*"] ?? {}),
		...(policies?.[toolName] ?? {}),
	};
}

interface PreparedToolExecution {
	toolCall: AgentToolCallPart;
	tool?: AgentTool;
	input: unknown;
	skipReason?: string;
}

const HOOK_ATTRIBUTE_ESCAPES: Record<string, string> = {
	_: "__",
	'"': "_q_",
	"<": "_lt_",
	">": "_gt_",
};

function sanitizeHookAttribute(value: string): string {
	// The underscore escapes itself, which makes the encoding injective
	// (uniquely decodable escape code): no two distinct ids can collapse to
	// the same sanitized stamp.
	return value.replace(/[_"<>]/g, (char) => HOOK_ATTRIBUTE_ESCAPES[char]);
}

function formatHookContextBlock(
	source: "PreToolUse" | "PostToolUse",
	toolCall: AgentToolCallPart,
	text: string,
): string {
	// Tool identity keeps each block attributable to its call: contexts are
	// batched into one message after the tool results, and parallel tool
	// execution collects them in completion order, so position alone cannot
	// identify the tool. Attribute values are sanitized and embedded
	// hook_context tags (opening and closing) neutralized so neither
	// provider-supplied ids nor hook output can corrupt or spoof the block
	// markup.
	const toolName = sanitizeHookAttribute(toolCall.toolName);
	const toolCallId = sanitizeHookAttribute(toolCall.toolCallId);
	const body = text.trim().replace(/<(\/?)hook_context/gi, "<\\$1hook_context");
	return `<hook_context source="${source}" tool_name="${toolName}" tool_call_id="${toolCallId}">\n${body}\n</hook_context>`;
}

export async function executeToolCalls(
	ctx: AgentLoopContext,
	toolCalls: AgentToolCallPart[],
): Promise<AgentMessage[]> {
	ctx.pendingHookContexts = [];
	const prepared: PreparedToolExecution[] = [];
	for (const toolCall of toolCalls) {
		prepared.push(await prepareToolExecution(ctx, toolCall));
	}

	const results: AgentMessage[] = [];
	for (let index = 0; index < prepared.length; ) {
		const execution = prepared[index];
		const mode = execution.tool?.executionMode ?? ctx.config.toolExecution;
		if (mode === "sequential") {
			results.push(await executePreparedTool(ctx, execution));
			index += 1;
			continue;
		}

		// Only adjacent parallel calls overlap. An ordinary sequential tool
		// must wait for the group before it, and finish before the next group.
		const start = index;
		while (
			index < prepared.length &&
			(prepared[index].tool?.executionMode ?? ctx.config.toolExecution) ===
				"parallel"
		) {
			index += 1;
		}
		results.push(
			...(await Promise.all(
				prepared
					.slice(start, index)
					.map((call) => executePreparedTool(ctx, call)),
			)),
		);
	}
	return results;
}

export function findCompletingToolMessage(
	ctx: AgentLoopContext,
	toolCalls: AgentToolCallPart[],
	toolMessages: AgentMessage[],
): AgentMessage | undefined {
	for (let index = 0; index < toolCalls.length; index += 1) {
		const toolCall = toolCalls[index];
		if (ctx.tools.get(toolCall.toolName)?.lifecycle?.completesRun !== true) {
			continue;
		}
		const toolMessage = toolMessages[index];
		const result = toolMessage?.content.find(
			(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
				part.type === "tool-result" && part.toolCallId === toolCall.toolCallId,
		);
		if (result && !result.isError) {
			return toolMessage;
		}
	}
	return undefined;
}

async function prepareToolExecution(
	ctx: AgentLoopContext,
	toolCall: AgentToolCallPart,
): Promise<PreparedToolExecution> {
	const tool = ctx.tools.get(toolCall.toolName);
	let input = toolCall.input;
	let skipReason: string | undefined;
	const metadata =
		toolCall.metadata &&
		typeof toolCall.metadata === "object" &&
		!Array.isArray(toolCall.metadata)
			? (toolCall.metadata as Record<string, unknown>)
			: undefined;

	if (typeof metadata?.inputParseError === "string") {
		skipReason = metadata.inputParseError;
	}

	const toolSource =
		metadata?.toolSource &&
		typeof metadata.toolSource === "object" &&
		!Array.isArray(metadata.toolSource)
			? (metadata.toolSource as Record<string, unknown>)
			: undefined;
	if (toolSource?.executionMode === "provider") {
		const providerId =
			typeof toolSource.providerId === "string"
				? toolSource.providerId
				: "provider";
		skipReason = `Tool execution is disabled for provider ${providerId}`;
	}

	if (tool && !skipReason) {
		input = normalizeJsonLikeStringsForSchema(input, tool.inputSchema);
	}

	let policyOverride: ToolPolicy | undefined;
	if (tool && !skipReason) {
		for (const hook of ctx.hooks.beforeTool) {
			const result = (await hook({
				snapshot: ctx.snapshot(),
				tool,
				toolCall: { ...toolCall, input },
				input,
			})) as AgentBeforeToolResult | undefined;
			if (result?.input !== undefined) {
				input = result.input;
			}
			if (result?.policy) {
				policyOverride = {
					...policyOverride,
					...result.policy,
				};
			}
			if (result?.appendContext?.trim()) {
				ctx.pendingHookContexts.push(
					formatHookContextBlock("PreToolUse", toolCall, result.appendContext),
				);
			}
			ctx.applyStopControl(result);
			if (result?.skip) {
				skipReason =
					result.reason ?? `Tool ${tool.name} was blocked by a runtime hook`;
				break;
			}
		}
	}

	if (tool && !skipReason) {
		const policy = {
			...resolveToolPolicy(toolCall.toolName, ctx.config.toolPolicies),
			...policyOverride,
		};
		if (policy.enabled === false) {
			skipReason = `Tool "${toolCall.toolName}" is disabled by policy`;
		} else if (policy.autoApprove === false) {
			const approval = await requestToolApproval(ctx, toolCall, input, policy);
			if (!approval.approved) {
				const reason = approval.reason ?? "Tool was not executed";
				skipReason = `${reason} -- ${TOOL_REJECTION_SUFFIX}`;
			}
		}
	}

	return {
		toolCall: { ...toolCall, input },
		tool,
		input,
		skipReason,
	};
}

async function requestToolApproval(
	ctx: AgentLoopContext,
	toolCall: AgentToolCallPart,
	input: unknown,
	policy: ToolPolicy,
): Promise<ToolApprovalResult> {
	const requestApproval = ctx.config.requestToolApproval;
	if (!requestApproval) {
		return {
			approved: false,
			reason: `Tool "${toolCall.toolName}" requires approval but no approval callback is configured`,
		};
	}
	try {
		return await requestApproval({
			sessionId:
				ctx.config.sessionId?.trim() ||
				ctx.config.conversationId?.trim() ||
				ctx.state.runId ||
				ctx.state.agentId,
			agentId: ctx.state.agentId,
			conversationId:
				ctx.config.conversationId?.trim() ||
				ctx.state.runId ||
				ctx.state.agentId,
			iteration: ctx.state.iteration,
			toolCallId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			input,
			policy,
		});
	} catch (error) {
		return {
			approved: false,
			reason: `Tool "${toolCall.toolName}" approval request failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

async function executePreparedTool(
	ctx: AgentLoopContext,
	prepared: PreparedToolExecution,
): Promise<AgentMessage> {
	const startedAt = new Date();
	await ctx.emit({
		type: "tool-started",
		snapshot: ctx.snapshot(),
		iteration: ctx.state.iteration,
		toolCall: prepared.toolCall,
	});

	let result: AgentToolResult;
	if (prepared.skipReason) {
		result = {
			output: { error: prepared.skipReason },
			isError: true,
		};
	} else if (!prepared.tool) {
		result = {
			output: { error: `Unknown tool: ${prepared.toolCall.toolName}` },
			isError: true,
		};
	} else {
		try {
			const output = await prepared.tool.execute(prepared.input, {
				sessionId: ctx.config.sessionId,
				agentId: ctx.state.agentId,
				conversationId: ctx.config.conversationId,
				runId: ctx.state.runId ?? createUID("run"),
				iteration: ctx.state.iteration,
				toolCallId: prepared.toolCall.toolCallId,
				signal: ctx.abortController?.signal,
				userMessageSignal: ctx.userMessageController.signal,
				metadata: ctx.config.toolContextMetadata,
				snapshot: ctx.snapshot(),
				emitUpdate: (update: unknown) => {
					void ctx.emit({
						type: "tool-updated",
						snapshot: ctx.snapshot(),
						iteration: ctx.state.iteration,
						toolCall: prepared.toolCall,
						update,
					});
				},
			});
			result = { output };
		} catch (error) {
			result = {
				output: {
					error: error instanceof Error ? error.message : String(error),
				},
				isError: true,
			};
		}
	}

	const endedAt = new Date();
	const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

	if (prepared.tool) {
		for (const hook of ctx.hooks.afterTool) {
			const after = (await hook({
				snapshot: ctx.snapshot(),
				tool: prepared.tool,
				toolCall: prepared.toolCall,
				input: prepared.input,
				result,
				startedAt,
				endedAt,
				durationMs,
			})) as AgentAfterToolResult | undefined;
			if (after?.appendContext?.trim()) {
				ctx.pendingHookContexts.push(
					formatHookContextBlock(
						"PostToolUse",
						prepared.toolCall,
						after.appendContext,
					),
				);
			}
			ctx.applyStopControl(after);
			if (after?.result) {
				result = after.result;
			}
		}
	}

	const message = createMessage("tool", [
		{
			type: "tool-result",
			toolCallId: prepared.toolCall.toolCallId,
			toolName: prepared.toolCall.toolName,
			output: result.output,
			isError: result.isError,
		},
	]);

	await ctx.emit({
		type: "tool-finished",
		snapshot: ctx.snapshot(),
		iteration: ctx.state.iteration,
		toolCall: prepared.toolCall,
		message,
	});

	return message;
}

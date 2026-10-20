#!/usr/bin/env bun

/**
 * Replays a stored conversation through the automatic compaction trigger,
 * call by call, with the basic strategy (no model call), the stale-context
 * pruning of a model without a prompt cache, and the provider counts the
 * transcript recorded, and prints when compaction would have run.
 *
 *   bun --conditions=development run scripts/replay-compaction.ts <session dir> [--budget 150000] [--tools-chars 39000] [--cached]
 *
 * The directory is a `~/.cline/data/sessions/<id>` folder. Each assistant
 * message is one model call; the request before it is the canonical
 * transcript up to that point, and the previous call's `metrics.inputTokens`
 * stands in for the provider's count.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MessageWithMetadata } from "@plinycode/shared";
import { estimateRequestInputTokens } from "@plinycode/shared";
import {
	createCompactionStateAwarePrepareTurn,
	createContextCompactionPrepareTurn,
} from "../src/extensions/context/compaction";
import {
	agentMessagesToMessagesWithMetadata,
	messagesToAgentMessages,
} from "../src/runtime/config/agent-message-codec";
import type { SessionCompactionState } from "../src/session/models/session-compaction";
import { dropPriorTurnReasoning } from "../src/session/services/messages/prior-turn-reasoning";
import {
	pruneStaleContext,
	resolveStaleContextOptions,
} from "../src/session/services/messages/stale-context";
import type { ProviderConfig } from "../src/types/provider-settings";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		budget: { type: "string" },
		"tools-chars": { type: "string" },
		cached: { type: "boolean", default: false },
		verbose: { type: "boolean", default: false },
	},
});

const directory = positionals[0];
if (!directory) {
	console.error(
		"usage: replay-compaction.ts <session dir> [--budget N] [--tools-chars N] [--cached]",
	);
	process.exit(1);
}
const budget = Number(values.budget ?? 150_000);
const toolsChars = Number(values["tools-chars"] ?? 39_000);

async function loadSession(dir: string) {
	const absolute = resolve(dir);
	if (!(await stat(absolute)).isDirectory()) {
		throw new Error(`not a directory: ${absolute}`);
	}
	const names = await readdir(absolute);
	const file = names.find((name) => name.endsWith(".messages.json"));
	if (!file) {
		throw new Error(`no *.messages.json in ${absolute}`);
	}
	const payload = JSON.parse(await readFile(join(absolute, file), "utf8")) as {
		messages: MessageWithMetadata[];
		system_prompt?: string;
	};
	return {
		messages: payload.messages,
		systemPrompt: payload.system_prompt ?? "",
	};
}

const { messages, systemPrompt } = await loadSession(directory);
const tools = [
	{
		name: "tools_placeholder",
		description: "x".repeat(toolsChars),
		inputSchema: { type: "object", properties: {} },
	},
];
const staleContext = resolveStaleContextOptions(undefined, {
	promptCache: values.cached === true,
});
const pruneForApi = async (candidate: MessageWithMetadata[]) =>
	agentMessagesToMessagesWithMetadata(
		pruneStaleContext(
			dropPriorTurnReasoning(messagesToAgentMessages(candidate)),
			staleContext,
		),
	);

const prepare = createContextCompactionPrepareTurn({
	providerId: "pliny",
	modelId: "pliny/auto-free",
	providerConfig: {
		providerId: "pliny",
		modelId: "pliny/auto-free",
	} as ProviderConfig,
	compaction: { enabled: true, strategy: "basic" },
	logger: undefined,
});
if (!prepare) {
	throw new Error("compaction disabled");
}
let state: SessionCompactionState | undefined;
const stateAware = createCompactionStateAwarePrepareTurn({
	compact: prepare,
	getState: () => state,
	saveState: (next) => {
		state = next;
	},
});

let compactions = 0;
let calls = 0;
let previous:
	| { inputTokens: number; estimatedTokens: number; iteration: number }
	| undefined;
let iteration = 0;
const notices: string[] = [];
for (let index = 0; index < messages.length; index += 1) {
	if (messages[index].role !== "assistant") {
		continue;
	}
	calls += 1;
	iteration += 1;
	const canonical = messages.slice(0, index);
	if (canonical.length < 2) {
		continue;
	}
	const apiMessages = await pruneForApi(canonical);
	const estimated = estimateRequestInputTokens({
		systemPrompt,
		messages: apiMessages,
		tools,
	});
	let compacted = false;
	const result = await stateAware({
		agentId: "replay",
		conversationId: "replay",
		parentAgentId: null,
		iteration,
		messages: canonical,
		apiMessages,
		abortSignal: new AbortController().signal,
		systemPrompt,
		tools,
		model: {
			id: "pliny/auto-free",
			provider: "pliny",
			info: {
				id: "pliny/auto-free",
				contextWindow: 256_000,
				maxInputTokens: budget,
				maxTokens: 32_768,
			},
		},
		previousRequest: previous,
		pruneForApi,
		emitStatusNotice: (message, metadata) => {
			if (message.endsWith("compacted")) {
				compacted = true;
			}
			if (values.verbose) {
				notices.push(
					`${message} ${JSON.stringify(metadata?.diagnostics ?? {}).slice(0, 300)}`,
				);
			}
		},
	});
	if (compacted) {
		compactions += 1;
	}
	const sent = result?.messages ?? apiMessages;
	const sentEstimate = estimateRequestInputTokens({
		systemPrompt,
		messages: sent,
		tools,
	});
	const reported = messages[index].metrics?.inputTokens;
	if (values.verbose || compacted) {
		console.log(
			`call ${calls} (msg ${index}): E=${(estimated / 1000).toFixed(1)}k sent=${(sentEstimate / 1000).toFixed(1)}k reported=${reported ?? "-"}${compacted ? "  COMPACTED" : ""}`,
		);
	}
	previous =
		typeof reported === "number" && reported > 0
			? { inputTokens: reported, estimatedTokens: sentEstimate, iteration }
			: undefined;
}
for (const line of notices) {
	console.log(line);
}
console.log(
	`${calls} calls, ${compactions} compactions (budget ${budget}, tools ${toolsChars} chars, ${values.cached ? "cached" : "uncached"} pruning)`,
);

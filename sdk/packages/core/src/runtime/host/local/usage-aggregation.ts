import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	accumulateUsageTotals,
	createInitialAccumulatedUsage,
	summarizeUsageFromMessages,
} from "../../../services/usage";
import type { SessionManifest } from "../../../session/models/session-manifest";
import type { SessionAccumulatedUsage } from "../runtime-host";
import { readPersistedMessagesFile } from "../runtime-host-support";

function asFiniteUsageNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function parseAccumulatedUsage(
	value: unknown,
): SessionAccumulatedUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const inputTokens = asFiniteUsageNumber(record.inputTokens);
	const outputTokens = asFiniteUsageNumber(record.outputTokens);
	const cacheReadTokens = asFiniteUsageNumber(record.cacheReadTokens);
	const cacheWriteTokens = asFiniteUsageNumber(record.cacheWriteTokens);
	const totalCost = asFiniteUsageNumber(record.totalCost);
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined ||
		totalCost === undefined
	) {
		return undefined;
	}
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalCost,
	};
}

function maxAccumulatedUsage(
	left: SessionAccumulatedUsage,
	right: SessionAccumulatedUsage,
): SessionAccumulatedUsage {
	return {
		inputTokens: Math.max(left.inputTokens, right.inputTokens),
		outputTokens: Math.max(left.outputTokens, right.outputTokens),
		cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
		cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
		totalCost: Math.max(left.totalCost, right.totalCost),
	};
}

export async function seedAggregateUsageFromArtifacts(input: {
	initialUsage: SessionAccumulatedUsage;
	sessionDir: string;
	rootMessagesPath: string;
	manifest: SessionManifest;
}): Promise<SessionAccumulatedUsage> {
	const teammateUsage = await summarizePersistedTeammateUsage(
		input.sessionDir,
		input.rootMessagesPath,
		input.manifest.session_id,
	);
	const aggregateUsage = accumulateUsageTotals(
		input.initialUsage,
		teammateUsage,
	);
	return withPersistedAggregateUsageFloor(aggregateUsage, input.manifest);
}

async function summarizePersistedTeammateUsage(
	sessionDir: string,
	rootMessagesPath: string,
	sessionId: string,
): Promise<SessionAccumulatedUsage> {
	const rootPath = resolve(rootMessagesPath);
	const defaultRootMessagesFilename = `${sessionId}.messages.json`;
	let filenames: string[];
	try {
		filenames = readdirSync(sessionDir);
	} catch {
		return createInitialAccumulatedUsage();
	}

	let usage = createInitialAccumulatedUsage();
	for (const filename of filenames) {
		if (!filename.endsWith(".messages.json")) continue;
		if (filename === defaultRootMessagesFilename) continue;
		const messagesPath = resolve(sessionDir, filename);
		if (messagesPath === rootPath) continue;
		const messages = await readPersistedMessagesFile(messagesPath);
		if (messages.length === 0) continue;
		usage = accumulateUsageTotals(usage, summarizeUsageFromMessages(messages));
	}
	return usage;
}

function withPersistedAggregateUsageFloor(
	usage: SessionAccumulatedUsage,
	manifest: SessionManifest,
): SessionAccumulatedUsage {
	const persistedAggregateUsage = parseAccumulatedUsage(
		manifest.metadata?.aggregateUsage,
	);
	if (persistedAggregateUsage) {
		return maxAccumulatedUsage(usage, persistedAggregateUsage);
	}
	const aggregatedAgentsCost = manifest.metadata?.aggregatedAgentsCost;
	if (
		typeof aggregatedAgentsCost !== "number" ||
		!Number.isFinite(aggregatedAgentsCost) ||
		aggregatedAgentsCost <= usage.totalCost
	) {
		return usage;
	}
	return { ...usage, totalCost: aggregatedAgentsCost };
}

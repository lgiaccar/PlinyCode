/**
 * Runs one eval case headlessly: a fresh copy of the fixture, a one-shot
 * `ClineCore` session with the default tools, every tool auto-approved, and
 * the case's cassette played back (or recorded) through the VCR.
 */

import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	type AgentResult,
	ClineCore,
	createToolPoliciesWithPreset,
	getClineDefaultSystemPrompt,
} from "@plinycode/core";
import { startVcr } from "@plinycode/shared";
import type { EvalCase } from "./cases";

export type VcrRunMode = "playback" | "record";

/** The Pliny provider id in the engine's provider registry. */
const PROVIDER_ID = "pliny";

export interface SessionRunOptions {
	vcrMode: VcrRunMode;
	/** Root of the per-case temp workspaces. */
	workRoot: string;
	/** Directory holding the fixtures. */
	fixturesDir: string;
	/** API key for --record; playback sends a placeholder. */
	apiKey?: string;
}

export interface SessionRunResult {
	workspace: string;
	result?: AgentResult;
	/** Set when the run threw or timed out instead of finishing. */
	error?: string;
	timedOut: boolean;
	wallMs: number;
	cassette: { used: number; total: number };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Copy the case's fixture into a new temp directory and return its path. */
export function prepareWorkspace(
	evalCase: EvalCase,
	options: SessionRunOptions,
): string {
	const workspace = mkdtempSync(join(options.workRoot, `${evalCase.id}-`));
	cpSync(join(options.fixturesDir, evalCase.fixture), workspace, {
		recursive: true,
	});
	return workspace;
}

export async function runCaseSession(
	evalCase: EvalCase,
	options: SessionRunOptions,
): Promise<SessionRunResult> {
	const workspace = prepareWorkspace(evalCase, options);
	const timeoutMs =
		(evalCase.timeoutSeconds ?? (options.vcrMode === "record" ? 900 : 120)) *
		1000;
	// Patch the global fetch as well as passing the VCR fetch explicitly, so a
	// request that does not go through the provider config still hits the
	// cassette (and, in playback, fails loudly instead of reaching the network).
	const vcr = startVcr({
		mode: options.vcrMode,
		cassettePath: evalCase.cassettePath,
		sseDelayMs: 0,
		patchGlobalFetch: true,
	});
	const startedAt = Date.now();
	const sessionId = `eval-${evalCase.id}-${startedAt}`;
	let core: ClineCore | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	try {
		core = await ClineCore.create({
			clientName: "plinycode-eval",
			fetch: vcr.fetch,
		});
		const apiKey = options.apiKey ?? "offline-playback";
		const run = core.start({
			config: {
				sessionId,
				providerId: PROVIDER_ID,
				modelId: evalCase.model,
				apiKey,
				providerConfig: {
					providerId: PROVIDER_ID,
					modelId: evalCase.model,
					apiKey,
					fetch: vcr.fetch,
				},
				cwd: workspace,
				workspaceRoot: workspace,
				systemPrompt: getClineDefaultSystemPrompt({
					ide: "Visual Studio Code",
					mode: evalCase.mode,
					workspaceRoot: workspace,
					workspaceName: basename(workspace),
					providerId: PROVIDER_ID,
					platform: process.platform,
					planModeSwitchTool: false,
				}),
				mode: evalCase.mode,
				maxIterations: evalCase.maxIterations,
				enableTools: true,
				enableSpawnAgent: false,
				disableMcpSettingsTools: true,
				checkpoint: { enabled: false },
			},
			prompt: evalCase.prompt,
			interactive: false,
			toolPolicies: createToolPoliciesWithPreset("yolo"),
		});
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const outcome = await Promise.race([run, timeout]);
		if (outcome === "timeout") {
			timedOut = true;
			await core.stop(sessionId).catch(() => undefined);
			return {
				workspace,
				error: `timed out after ${timeoutMs / 1000}s`,
				timedOut,
				wallMs: Date.now() - startedAt,
				cassette: vcr.stats(),
			};
		}
		return {
			workspace,
			result: outcome.result,
			error: outcome.result ? undefined : "the session returned no result",
			timedOut,
			wallMs: Date.now() - startedAt,
			cassette: vcr.stats(),
		};
	} catch (error) {
		return {
			workspace,
			error: errorMessage(error),
			timedOut,
			wallMs: Date.now() - startedAt,
			cassette: vcr.stats(),
		};
	} finally {
		clearTimeout(timer);
		await core?.dispose().catch(() => undefined);
		vcr.stop();
		if (options.vcrMode === "record") {
			reformatCassette(evalCase.cassettePath);
		}
	}
}

/**
 * The VCR writes cassettes with two-space indents; rewrite a recorded one
 * with tabs so it passes the repo's Biome format check as committed.
 */
function reformatCassette(cassettePath: string): void {
	if (!existsSync(cassettePath)) {
		return;
	}
	const recordings: unknown = JSON.parse(readFileSync(cassettePath, "utf8"));
	writeFileSync(cassettePath, `${JSON.stringify(recordings, null, "\t")}\n`);
}

export function removeWorkspace(workspace: string): void {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
}

/** Tool calls that failed: a thrown error, or an output that reports `success: false`. */
export function collectToolErrors(
	result: AgentResult | undefined,
): Array<{ name: string; error: string }> {
	const errors: Array<{ name: string; error: string }> = [];
	for (const call of result?.toolCalls ?? []) {
		if (call.error) {
			errors.push({ name: call.name, error: call.error });
			continue;
		}
		const outputs = Array.isArray(call.output) ? call.output : [call.output];
		for (const output of outputs) {
			if (
				output &&
				typeof output === "object" &&
				(output as { success?: unknown }).success === false
			) {
				const record = output as { error?: unknown; result?: unknown };
				errors.push({
					name: call.name,
					error: String(record.error ?? record.result ?? "success: false"),
				});
			}
		}
	}
	return errors;
}

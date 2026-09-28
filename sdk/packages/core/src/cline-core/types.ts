import type { MessageWithMetadata } from "@plinycode/llms";
import type {
	AgentConfig,
	BasicLogger,
	ITelemetryService,
} from "@plinycode/shared";
import type { CheckpointEntry } from "../hooks/checkpoint-hooks";
import type { RuntimeCapabilities } from "../runtime/capabilities";
import type { SessionHistoryListOptions } from "../runtime/host/history";
import type { SessionBackend } from "../runtime/host/host";
import type {
	LocalRuntimeStartOptions,
	StartSessionInput,
	StartSessionResult,
} from "../runtime/host/runtime-host";
import type { FeatureFlagsService } from "../services/feature-flags";
import type { CheckpointWorkspaceCompareResult } from "../session/checkpoint-diff";
import type { ClineCoreStartConfig } from "../types/config";
import type { SessionMessagesArtifactUploader } from "../types/session";

export type { ClineCoreSettingsApi } from "../settings";

export type ClineCoreListHistoryOptions = SessionHistoryListOptions;

export interface ClineCoreStartInput
	extends Omit<StartSessionInput, "config" | "localRuntime"> {
	config: ClineCoreStartConfig;
	localRuntime?: LocalRuntimeStartOptions;
}

export interface RestoreOptions {
	/**
	 * Restore the message history by starting a new session fork trimmed to
	 * `checkpointRunCount`. Defaults to true.
	 */
	messages?: boolean;
	/**
	 * Restore the workspace files from the checkpoint's git snapshot.
	 * Defaults to true.
	 */
	workspace?: boolean;
	/**
	 * Start the forked session with messages before the checkpoint user message
	 * while still returning messages through that user message. This is for
	 * clients that put the checkpoint message back into a compose box so it can
	 * be edited and submitted again without duplicating it in session history.
	 */
	omitCheckpointMessageFromSession?: boolean;
}

export interface RestoreInput {
	sessionId: string;
	checkpointRunCount: number;
	start?: ClineCoreStartInput;
	cwd?: string;
	restore?: RestoreOptions;
}

export interface RestoreResult {
	sessionId?: string;
	startResult?: StartSessionResult;
	messages?: MessageWithMetadata[];
	checkpoint: CheckpointEntry;
}

export interface CompareCheckpointInput {
	sessionId: string;
	checkpointRunCount: number;
	cwd?: string;
}

export type CompareCheckpointResult = CheckpointWorkspaceCompareResult;

export interface ClineCoreOptions {
	/**
	 * A human-readable name for this SDK client (e.g. `"my-app"`, `"acme-bot"`).
	 * Used to identify the consumer in telemetry and logs.
	 */
	clientName?: string;
	/**
	 * A stable identifier for this machine or user, used for telemetry attribution.
	 * Defaults to the system machine ID, falling back to a generated `cl-<nanoid>` persisted
	 * at `~/.cline/data/machine-id`.
	 */
	distinctId?: string;
	/**
	 * Client-owned runtime capabilities. Core adapts these handlers to the
	 * selected runtime backend so apps implement interactive behavior once.
	 */
	capabilities?: RuntimeCapabilities;
	/**
	 * Telemetry service instance to use for capturing events and usage.
	 * If omitted, telemetry is a no-op.
	 */
	telemetry?: ITelemetryService;
	/**
	 * Feature flags service for this ClineCore instance.
	 * If omitted, Core uses a no-op provider with default flag values.
	 */
	featureFlags?: FeatureFlagsService;
	/**
	 * Optional structured logger for core-side operational diagnostics such as
	 * runtime-host selection and fallback decisions.
	 */
	logger?: BasicLogger;
	/**
	 * Per-tool approval policies that control whether a tool runs automatically,
	 * requires user confirmation, or is blocked entirely.
	 */
	toolPolicies?: AgentConfig["toolPolicies"];
	/**
	 * Optional hook invoked after `messages.json` is persisted to disk.
	 * Consumers can use this to mirror session transcripts into remote storage.
	 */
	messagesArtifactUploader?: SessionMessagesArtifactUploader;
	/**
	 * Custom `fetch` implementation forwarded to the AI gateway providers used
	 * by local sessions. When supplied, it is threaded into each
	 * `ProviderConfig.fetch` built during session bootstrap, which in turn
	 * populates `GatewayProviderSettings.fetch` (and the top-level
	 * `GatewayConfig.fetch` fallback) so hosts can inject custom HTTP behavior
	 * such as proxies, retries, tracing, or test doubles.
	 *
	 * Per-session or per-provider overrides still win: an explicit
	 * `config.fetch` on `CoreSessionConfig` or a stored provider-level `fetch`
	 * takes precedence over this default.
	 */
	fetch?: typeof fetch;
	/**
	 * An already-constructed session backend to use instead of resolving one automatically.
	 * Intended for testing or embedding a custom persistence layer.
	 * @internal
	 */
	sessionService?: SessionBackend;
	/**
	 * Optional hook invoked before each session starts.
	 * Use this to prepare workspace-scoped runtime state and then return an
	 * adapter that mutates the shared session input before core starts the run.
	 * This runs before the execution host resolves an omitted workspace, so
	 * pathless starts expose neither `cwd` nor `workspaceRoot` to this hook.
	 */
	prepare?: (
		input: ClineCoreStartInput,
	) =>
		| Promise<StartSessionBootstrap | undefined>
		| StartSessionBootstrap
		| undefined;
}

export interface StartSessionBootstrap {
	applyToStartSessionInput(
		input: ClineCoreStartInput,
	): Promise<ClineCoreStartInput> | ClineCoreStartInput;
	dispose?(): Promise<void> | void;
}

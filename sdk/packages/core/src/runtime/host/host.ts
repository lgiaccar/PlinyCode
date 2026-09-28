import { captureSdkError } from "@plinycode/shared";
import type { ClineCoreOptions } from "../../cline-core/types";
import { SqliteSessionStore } from "../../services/storage/sqlite-session-store";
import { resolveCoreDistinctId } from "../../services/telemetry/distinct-id";
import { FileSessionService } from "../../session/services/file-session-service";
import { CoreSessionService } from "../../session/services/session-service";
import { LocalRuntimeHost } from "./local-runtime-host";
import type { RuntimeHost } from "./runtime-host";

export type SessionBackend = CoreSessionService | FileSessionService;

let cachedBackend: SessionBackend | undefined;
let backendInitPromise: Promise<SessionBackend> | undefined;

async function reconcileDeadSessionsIfSupported(
	backend: SessionBackend,
): Promise<void> {
	const service = backend as SessionBackend & {
		reconcileDeadSessions?: (limit?: number) => Promise<number>;
	};
	await service.reconcileDeadSessions?.().catch(() => {});
}

function createLocalBackend(options: ClineCoreOptions): SessionBackend {
	try {
		const store = new SqliteSessionStore();
		store.init();
		return new CoreSessionService(store, {
			messagesArtifactUploader: options.messagesArtifactUploader,
			logger: options.logger,
		});
	} catch (error) {
		// Fallback to file-based session service if SQLite is unavailable.
		options.telemetry?.capture({
			event: "session_backend_fallback",
			properties: {
				requestedBackend: "sqlite",
				fallbackBackend: "file",
			},
		});
		captureSdkError(options.telemetry, {
			component: "core",
			operation: "session_backend.sqlite_init",
			error,
			severity: "warn",
			handled: true,
			context: {
				requestedBackend: "sqlite",
				fallbackBackend: "file",
			},
		});
		return new FileSessionService(undefined, {
			messagesArtifactUploader: options.messagesArtifactUploader,
			logger: options.logger,
		});
	}
}

function createLocalRuntimeHost(
	options: ClineCoreOptions,
	distinctId: string,
	backend?: SessionBackend,
): LocalRuntimeHost {
	return new LocalRuntimeHost({
		sessionService:
			backend ?? options.sessionService ?? createLocalBackend(options),
		capabilities: options.capabilities,
		logger: options.logger,
		telemetry: options.telemetry,
		toolPolicies: options.toolPolicies,
		distinctId,
		fetch: options.fetch,
	});
}

export async function resolveSessionBackend(
	options: ClineCoreOptions,
): Promise<SessionBackend> {
	if (cachedBackend) {
		return cachedBackend;
	}
	if (backendInitPromise) {
		return await backendInitPromise;
	}

	backendInitPromise = (async () => {
		cachedBackend = createLocalBackend(options);
		await reconcileDeadSessionsIfSupported(cachedBackend);
		return cachedBackend;
	})().finally(() => {
		backendInitPromise = undefined;
	});

	return await backendInitPromise;
}

export async function createRuntimeHost(
	options: ClineCoreOptions,
): Promise<RuntimeHost> {
	const distinctId = resolveCoreDistinctId(options.distinctId);
	options.telemetry?.setDistinctId(distinctId);
	return createLocalRuntimeHost(options, distinctId);
}

import {
	type AgentExtension,
	buildRemoteConfigSessionBlobUploadMetadata,
	clearRemoteConfigSessionBlobUpload,
	createSessionId,
	createRemoteConfigSessionMessagesArtifactUploader as createSharedRemoteConfigSessionMessagesArtifactUploader,
	type PreparedRemoteConfigRuntime,
	type PrepareRemoteConfigRuntimeOptions,
	prepareRemoteConfigRuntime,
	REMOTE_CONFIG_SESSION_BLOB_UPLOAD_METADATA_KEY,
	readRemoteConfigSessionBlobUploadMetadata,
	registerRemoteConfigSessionBlobUpload,
} from "@plinycode/shared";
import type { ClineCoreStartInput } from "../cline-core/types";
import type { SessionMessagesArtifactUploader } from "../types/session";

export type PrepareRemoteConfigCoreIntegrationOptions =
	PrepareRemoteConfigRuntimeOptions;

export interface PreparedRemoteConfigCoreIntegration {
	prepared: PreparedRemoteConfigRuntime;
	extensions: AgentExtension[];
	applyToStartSessionInput(input: ClineCoreStartInput): ClineCoreStartInput;
	dispose(): Promise<void>;
}

export function createRemoteConfigSessionMessagesArtifactUploader(): SessionMessagesArtifactUploader {
	const uploader = createSharedRemoteConfigSessionMessagesArtifactUploader();
	return {
		async uploadMessagesFile(input) {
			await uploader.uploadMessagesFile(input);
		},
	};
}

export async function prepareRemoteConfigCoreIntegration(
	options: PrepareRemoteConfigCoreIntegrationOptions,
): Promise<PreparedRemoteConfigCoreIntegration> {
	const prepared = await prepareRemoteConfigRuntime(options);
	const extensions = [prepared.pluginDefinition];
	const userDistinctId = prepared.claims?.subject;
	const blobUploadMetadataTemplate = buildRemoteConfigSessionBlobUploadMetadata(
		prepared.bundle?.remoteConfig,
		userDistinctId,
	);
	let registeredSessionId: string | undefined;

	return {
		prepared,
		extensions,
		applyToStartSessionInput(input: ClineCoreStartInput): ClineCoreStartInput {
			const existingExtensions = input.config.extensions ?? [];
			const sessionId = blobUploadMetadataTemplate
				? input.config.sessionId?.trim() || createSessionId()
				: input.config.sessionId;
			if (sessionId && blobUploadMetadataTemplate) {
				registeredSessionId = sessionId;
			}
			const blobUploadMetadata =
				sessionId && blobUploadMetadataTemplate
					? registerRemoteConfigSessionBlobUpload(
							sessionId,
							prepared.bundle?.remoteConfig,
							userDistinctId,
						)
					: undefined;
			const sessionMetadata = blobUploadMetadata
				? {
						...(input.sessionMetadata ?? {}),
						[REMOTE_CONFIG_SESSION_BLOB_UPLOAD_METADATA_KEY]:
							blobUploadMetadata,
					}
				: input.sessionMetadata;
			return {
				...input,
				...(sessionMetadata ? { sessionMetadata } : {}),
				config: {
					...input.config,
					...(sessionId ? { sessionId } : {}),
					extensions: [...existingExtensions, ...extensions],
				},
			};
		},
		async dispose(): Promise<void> {
			if (registeredSessionId) {
				clearRemoteConfigSessionBlobUpload(registeredSessionId);
			}
		},
	};
}

export {
	buildRemoteConfigSessionBlobUploadMetadata,
	REMOTE_CONFIG_SESSION_BLOB_UPLOAD_METADATA_KEY,
	readRemoteConfigSessionBlobUploadMetadata,
	registerRemoteConfigSessionBlobUpload,
};

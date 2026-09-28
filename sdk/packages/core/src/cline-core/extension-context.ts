import type {
	BasicLogger,
	ExtensionContext,
	ITelemetryService,
} from "@plinycode/shared";

export interface ClineCoreExtensionContextInput {
	context?: ExtensionContext;
	clientName?: string;
	distinctId?: string;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}

/**
 * Fills the session's extension context with the ClineCore instance's client,
 * user, logger and telemetry, keeping any value the caller already set.
 */
export function createClineCoreExtensionContext(
	input: ClineCoreExtensionContextInput,
): ExtensionContext | undefined {
	const client =
		input.context?.client ??
		(input.clientName ? { name: input.clientName } : undefined);
	const user =
		input.context?.user ??
		(input.distinctId ? { distinctId: input.distinctId } : undefined);
	const logger = input.context?.logger ?? input.logger;
	const telemetry = input.context?.telemetry ?? input.telemetry;
	if (!client && !user && !logger && !telemetry) {
		return input.context;
	}
	return {
		...(input.context ?? {}),
		...(client ? { client } : {}),
		...(user ? { user } : {}),
		...(logger ? { logger } : {}),
		...(telemetry ? { telemetry } : {}),
	};
}

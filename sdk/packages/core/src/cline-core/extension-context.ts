import type { BasicLogger, ExtensionContext } from "@plinycode/shared";

export interface ClineCoreExtensionContextInput {
	context?: ExtensionContext;
	clientName?: string;
	distinctId?: string;
	logger?: BasicLogger;
}

/**
 * Fills the session's extension context with the ClineCore instance's client,
 * user and logger, keeping any value the caller already set.
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
	if (!client && !user && !logger) {
		return input.context;
	}
	return {
		...(input.context ?? {}),
		...(client ? { client } : {}),
		...(user ? { user } : {}),
		...(logger ? { logger } : {}),
	};
}

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
	formatMcpTimeoutErrorMessage,
	resolveMcpTimeoutSeconds,
} from "@plinycode/shared";

export function resolveMcpRequestTimeoutMs(timeoutSeconds: unknown): number {
	return resolveMcpTimeoutSeconds(timeoutSeconds) * 1000;
}

export function augmentMcpTimeoutError(
	error: unknown,
	serverName: string,
	timeoutMs: number,
): unknown {
	if (!(error instanceof McpError) || error.code !== ErrorCode.RequestTimeout) {
		return error;
	}
	return new McpError(
		error.code,
		formatMcpTimeoutErrorMessage(serverName, timeoutMs),
		error.data,
	);
}

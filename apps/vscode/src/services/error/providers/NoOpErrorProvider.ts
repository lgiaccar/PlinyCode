import { Logger } from "@/shared/services/Logger"
import type { ClineError } from "../ClineError"
import type { IErrorProvider } from "./IErrorProvider"

/**
 * Error provider that only logs locally. PlinyCode doesn't report errors to an
 * external service.
 */
export class NoOpErrorProvider implements IErrorProvider {
	async captureException(error: Error | ClineError, properties?: Record<string, unknown>): Promise<void> {
		Logger.error("[NoOpErrorProvider] captureException called", { error: error.message || String(error), properties })
	}

	public logException(error: Error | ClineError, _properties?: Record<string, unknown>): void {
		// Use Logger.error directly to avoid potential infinite recursion through Logger
		Logger.error("[NoOpErrorProvider]", error.message || String(error))
	}

	public logMessage(
		message: string,
		level?: "error" | "warning" | "log" | "debug" | "info",
		properties?: Record<string, unknown>,
	): void {
		Logger.log("[NoOpErrorProvider]", { message, level, properties })
	}

	public isEnabled(): boolean {
		return true
	}

	public getSettings() {
		return {
			enabled: true,
			hostEnabled: true,
			level: "all" as const,
		}
	}

	public async dispose(): Promise<void> {
		Logger.info("[NoOpErrorProvider] Disposing")
	}
}

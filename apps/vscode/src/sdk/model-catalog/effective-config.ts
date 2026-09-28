import type { ApiConfiguration } from "@shared/api"
import { StateManager } from "@/core/storage/StateManager"
import { getProviderSettingsManager } from "../provider-migration"
import type { AwsProviderConfig, EffectiveProviderConfig, GcpProviderConfig, ProviderId } from "./contracts"
import { toSdkProviderId } from "./sdk-provider-id"

type AuthConfig = NonNullable<EffectiveProviderConfig["auth"]>
type ExtrasConfig = NonNullable<EffectiveProviderConfig["extras"]>

type ConfigParts = Omit<EffectiveProviderConfig, "providerId">
type ConfigKey = keyof ConfigParts

type ProviderSettingsLike = {
	readonly apiKey?: string
	readonly baseUrl?: string
	readonly apiLine?: string
	readonly headers?: Readonly<Record<string, string>>
	readonly region?: string
	readonly aws?: AwsProviderConfig
	readonly gcp?: GcpProviderConfig
	readonly contextWindow?: number
	readonly auth?: AuthConfig
	readonly extras?: ExtrasConfig
}

// Legacy StateManager fields that still overlay providers.json. The Pliny
// provider keeps everything in providers.json; only the Cline account and OCA
// sign-in still write their credentials to StateManager.
const apiKeyFields: Partial<Record<string, keyof ApiConfiguration>> = {
	oca: "ocaApiKey",
	cline: "clineApiKey",
}

const baseUrlFields: Partial<Record<string, keyof ApiConfiguration>> = {
	oca: "ocaBaseUrl",
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function readHeaders(record: Record<string, unknown>, key: string): Readonly<Record<string, string>> | undefined {
	const value = record[key]
	if (!isPlainRecord(value)) {
		return undefined
	}

	const headers: Record<string, string> = {}
	for (const [headerName, headerValue] of Object.entries(value)) {
		if (typeof headerValue !== "string") {
			return undefined
		}
		headers[headerName] = headerValue
	}
	return Object.keys(headers).length > 0 ? headers : undefined
}

function readAuth(record: Record<string, unknown>): AuthConfig | undefined {
	const auth = record.auth
	if (!isPlainRecord(auth)) {
		return undefined
	}

	const accessToken = readString(auth, "accessToken")
	const refreshToken = readString(auth, "refreshToken")
	const accountId = readString(auth, "accountId")
	return accessToken || refreshToken || accountId ? { accessToken, refreshToken, accountId } : undefined
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key]
	return typeof value === "boolean" ? value : undefined
}

function readPositiveInteger(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value
	if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
		return Math.floor(parsed)
	}
	return undefined
}

function readGcp(record: Record<string, unknown>): GcpProviderConfig | undefined {
	const gcp = record.gcp
	if (!isPlainRecord(gcp)) {
		return undefined
	}

	const result: GcpProviderConfig = {
		projectId: readString(gcp, "projectId"),
		region: readString(gcp, "region"),
	}
	return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

function readAws(record: Record<string, unknown>): AwsProviderConfig | undefined {
	const aws = record.aws
	if (!isPlainRecord(aws)) {
		return undefined
	}

	const result: AwsProviderConfig = {
		accessKey: readString(aws, "accessKey"),
		secretKey: readString(aws, "secretKey"),
		sessionToken: readString(aws, "sessionToken"),
		authentication: readString(aws, "authentication"),
		profile: readString(aws, "profile"),
		usePromptCache: readBoolean(aws, "usePromptCache"),
		endpoint: readString(aws, "endpoint"),
		customModelBaseId: readString(aws, "customModelBaseId"),
		useCrossRegionInference: readBoolean(aws, "useCrossRegionInference") ?? readBoolean(record, "useCrossRegionInference"),
		useGlobalInference: readBoolean(aws, "useGlobalInference") ?? readBoolean(record, "useGlobalInference"),
	}
	return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

function readProviderSettings(providerId: ProviderId): ConfigParts {
	try {
		const settings: unknown = getProviderSettingsManager().getProviderSettings(toSdkProviderId(providerId))
		if (!isPlainRecord(settings)) {
			return {}
		}

		return {
			apiKey: readString(settings, "apiKey"),
			baseUrl: readString(settings, "baseUrl"),
			apiLine: readString(settings, "apiLine"),
			headers: readHeaders(settings, "headers"),
			region: readString(settings, "region"),
			aws: readAws(settings),
			gcp: readGcp(settings),
			contextWindow: readPositiveInteger(settings.contextWindow),
			auth: readAuth(settings),
			extras: isPlainRecord(settings.extras) ? settings.extras : undefined,
		} satisfies ProviderSettingsLike
	} catch {
		return {}
	}
}

function readStringFromConfig(config: ApiConfiguration, field: keyof ApiConfiguration | undefined): string | undefined {
	if (!field) {
		return undefined
	}
	const value = config[field]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function readStateAuth(provider: string, config: ApiConfiguration): AuthConfig | undefined {
	if (provider !== "cline") {
		return undefined
	}

	const accessToken = readStringFromConfig(config, "clineApiKey")
	const accountId = readStringFromConfig(config, "clineAccountId")
	return accessToken || accountId ? { accessToken, accountId } : undefined
}

function readStateConfig(providerId: ProviderId, config: ApiConfiguration): ConfigParts {
	const provider = providerId.toString()
	return {
		apiKey: readStringFromConfig(config, apiKeyFields[provider]),
		baseUrl: readStringFromConfig(config, baseUrlFields[provider]),
		auth: readStateAuth(provider, config),
	}
}

function assignIfDefined<T extends ConfigKey>(target: Partial<ConfigParts>, key: T, value: ConfigParts[T] | undefined): void {
	if (value !== undefined) {
		target[key] = value
	}
}

/**
 * Build an {@link EffectiveProviderConfig} by merging provider-owned settings
 * from SDK `providers.json` with the current StateManager effective API
 * configuration. StateManager's `getApiConfiguration()` already applies
 * task/session/remote-config overlays for legacy fields, so those values win.
 *
 * Mode-dependent model selection is intentionally excluded; callers use
 * `ProviderConfigStore.readSelection(providerId, mode)` for that.
 */
export function buildEffectiveProviderConfig(providerId: ProviderId): EffectiveProviderConfig {
	const providerSettings = readProviderSettings(providerId)
	const stateConfig = readStateConfig(providerId, StateManager.get().getApiConfiguration())
	const merged: Partial<ConfigParts> = {}

	assignIfDefined(merged, "apiKey", stateConfig.apiKey ?? providerSettings.apiKey)
	assignIfDefined(merged, "baseUrl", stateConfig.baseUrl ?? providerSettings.baseUrl)
	assignIfDefined(merged, "apiLine", providerSettings.apiLine)
	assignIfDefined(merged, "headers", providerSettings.headers)
	assignIfDefined(merged, "region", providerSettings.region)
	assignIfDefined(merged, "aws", providerSettings.aws)
	assignIfDefined(merged, "gcp", providerSettings.gcp)
	assignIfDefined(merged, "contextWindow", providerSettings.contextWindow)
	assignIfDefined(merged, "auth", stateConfig.auth ?? providerSettings.auth)
	assignIfDefined(merged, "extras", providerSettings.extras)

	return { providerId, ...merged }
}

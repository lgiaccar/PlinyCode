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

function assignIfDefined<T extends ConfigKey>(target: Partial<ConfigParts>, key: T, value: ConfigParts[T] | undefined): void {
	if (value !== undefined) {
		target[key] = value
	}
}

/**
 * Build an {@link EffectiveProviderConfig} from the provider's SDK
 * `providers.json` entry. Pliny, the only provider, keeps all of its
 * configuration there.
 *
 * Mode-dependent model selection is intentionally excluded; callers use
 * `ProviderConfigStore.readSelection(providerId, mode)` for that.
 */
export function buildEffectiveProviderConfig(providerId: ProviderId): EffectiveProviderConfig {
	const providerSettings = readProviderSettings(providerId)
	const merged: Partial<ConfigParts> = {}
	for (const key of Object.keys(providerSettings) as ConfigKey[]) {
		assignIfDefined(merged, key, providerSettings[key])
	}
	return { providerId, ...merged }
}

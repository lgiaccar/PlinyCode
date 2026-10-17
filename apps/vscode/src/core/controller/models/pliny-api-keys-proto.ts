import { PlinyApiKeyInfo, PlinyApiKeys as ProtoPlinyApiKeys } from "@shared/proto/cline/models"
import type { PlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import { resolveApiKey } from "@/sdk/cline-session-factory"

/** The stored keys as the Settings list shows them, and where requests take their key from. */
export function toProtoPlinyApiKeys(keys: PlinyApiKeys | undefined): ProtoPlinyApiKeys {
	const activeId = keys?.activeId()
	const envKeyPresent = !!process.env.PLINY_API_KEY?.trim()
	const source = keys?.activeKey()
		? "settings"
		: resolveApiKey("pliny")
			? "providersFile"
			: envKeyPresent
				? "environment"
				: "none"
	return ProtoPlinyApiKeys.create({
		keys: (keys?.list() ?? []).map((entry) =>
			PlinyApiKeyInfo.create({
				id: entry.id,
				name: entry.name,
				last4: entry.last4,
				active: entry.id === activeId,
				createdAt: entry.createdAt,
			}),
		),
		source,
		envKeyPresent,
	})
}

import { ProviderSettingsManager, type StoredProviderSettings } from "@plinycode/core"
import { Logger } from "@shared/services/Logger"
import { applyPlinyKey, extractPlinyKey, migratePlinyKey, setPersistFailedHandler } from "@/core/storage/pliny-key-secrets"

/**
 * A ProviderSettingsManager that keeps the Pliny API key in VS Code's
 * SecretStorage rather than in providers.json (see pliny-key-secrets.ts). Every
 * caller goes through `read()`/`write()`, so they still see the key in the
 * Pliny entry and never need to know where it is kept.
 */
export class SecretBackedProviderSettingsManager extends ProviderSettingsManager {
	constructor(options?: ConstructorParameters<typeof ProviderSettingsManager>[0]) {
		super(options)
		// If SecretStorage fails a write, put the key back into the file.
		setPersistFailedHandler(() => {
			try {
				this.write(this.read())
			} catch (error) {
				Logger.error("[PlinyKeySecrets] Failed to keep the Pliny API key in providers.json:", error)
			}
		})
	}

	override read(): StoredProviderSettings {
		return applyPlinyKey(super.read())
	}

	override write(state: StoredProviderSettings): void {
		super.write(extractPlinyKey(state))
	}

	/** Moves a Pliny key still stored in providers.json into SecretStorage. */
	async migrateKeyToSecrets(): Promise<boolean> {
		const stripped = await migratePlinyKey(super.read())
		if (!stripped) {
			return false
		}
		super.write(stripped)
		return true
	}
}

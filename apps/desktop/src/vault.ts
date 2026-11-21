import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type McpSecrets, mcpSecretsSchema } from "./mcp-contracts";

export interface Cipher {
	isEncryptionAvailable(): boolean;
	getSelectedStorageBackend?(): string;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
}
/** Main-process only. Stored values are never included in desktop snapshots. */
export class SecretVault {
	constructor(
		readonly file: string,
		private cipher: Cipher,
		private platform: NodeJS.Platform = process.platform,
	) {}
	private requireEncryption() {
		const backend = this.cipher.getSelectedStorageBackend?.();
		if (
			!this.cipher.isEncryptionAvailable() ||
			(this.platform === "linux" &&
				!["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
					backend ?? "",
				))
		)
			throw new Error(
				"OS credential encryption is unavailable. On Linux, unlock your desktop keyring. Secrets were not saved; plaintext storage is disabled.",
			);
	}
	private entries(): Record<string, string> {
		return existsSync(this.file)
			? JSON.parse(readFileSync(this.file, "utf8"))
			: {};
	}
	read(id: string): McpSecrets {
		const value = this.entries()[id];
		if (!value) return { env: {}, headers: {} };
		this.requireEncryption();
		return mcpSecretsSchema.parse(
			JSON.parse(this.cipher.decryptString(Buffer.from(value, "base64"))),
		);
	}
	write(id: string, value?: McpSecrets) {
		const entries = this.entries();
		if (value) {
			this.requireEncryption();
			entries[id] = this.cipher
				.encryptString(JSON.stringify(mcpSecretsSchema.parse(value)))
				.toString("base64");
		} else delete entries[id];
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(`${this.file}.tmp`, JSON.stringify(entries), {
			mode: 0o600,
			flush: true,
		});
		renameSync(`${this.file}.tmp`, this.file);
	}
}

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SecretVault } from "../src/vault";

const scratch = resolve(import.meta.dir, "../../../ai_output");
mkdirSync(scratch, { recursive: true });
const secrets = { env: { TOKEN: "linux-fixture-secret" }, headers: {} };
for (const backend of [
	undefined,
	"basic_text",
	"unknown",
	"gnome_libsecret",
	"kwallet",
	"kwallet5",
	"kwallet6",
]) {
	for (const available of [false, true]) {
		test(`Linux vault backend=${backend} available=${available}`, () => {
			const file = join(
				mkdtempSync(join(scratch, "linux-vault-")),
				"secrets.json",
			);
			let encryptions = 0;
			const cipher = {
				isEncryptionAvailable: () => available,
				getSelectedStorageBackend: backend ? () => backend : undefined,
				encryptString: (text: string) => {
					encryptions++;
					return Buffer.from(text.split("").reverse().join(""));
				},
				decryptString: (value: Buffer) =>
					value.toString().split("").reverse().join(""),
			};
			const vault = new SecretVault(file, cipher, "linux");
			if (
				!available ||
				!backend ||
				["basic_text", "unknown"].includes(backend)
			) {
				expect(() => vault.write("fixture", secrets)).toThrow(
					"plaintext storage is disabled",
				);
				expect(encryptions).toBe(0);
				expect(existsSync(file)).toBe(false);
			} else {
				vault.write("fixture", secrets);
				expect(new SecretVault(file, cipher, "linux").read("fixture")).toEqual(
					secrets,
				);
				expect(readFileSync(file, "utf8")).not.toContain(secrets.env.TOKEN);
				const locked = new SecretVault(
					file,
					{ ...cipher, isEncryptionAvailable: () => false },
					"linux",
				);
				expect(() => locked.read("fixture")).toThrow();
				locked.write("fixture");
				expect(locked.read("fixture")).toEqual({ env: {}, headers: {} });
			}
		});
	}
}

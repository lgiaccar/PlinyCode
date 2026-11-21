import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./options";

const credentialPath = () =>
	join(
		process.env.LOCALAPPDATA ?? homedir(),
		"PlinyCode",
		"cli",
		"credential.dpapi",
	);

function command(
	executable: string,
	args: string[],
	input = "",
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(
				new CliError("credential_store", "Credential store timed out.", 1),
			);
		}, 30000);
		child.stdout.on("data", (data) => {
			output += data.toString();
		});
		child.stderr.resume();
		child.stdin.on("error", () => {});
		child.on("error", () => {
			clearTimeout(timer);
			reject(
				new CliError(
					"credential_store",
					"Secure credential storage is unavailable. Use PLINY_API_KEY or install secret-tool on Linux.",
					1,
				),
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			code === 0
				? resolve(output.trim())
				: reject(
						new CliError(
							"credential_store",
							"Secure credential operation failed. Use PLINY_API_KEY if no keyring is available.",
							1,
						),
					);
		});
		child.stdin.end(input);
	});
}

async function dpapi(value: string, protect: boolean): Promise<string> {
	const operation = protect ? "Protect" : "Unprotect";
	const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${operation}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
	return command(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		value,
	);
}

export async function getApiKey(): Promise<string> {
	if (process.env.PLINY_API_KEY?.trim())
		return process.env.PLINY_API_KEY.trim();
	try {
		if (process.platform === "win32")
			return Buffer.from(
				await dpapi(await readFile(credentialPath(), "utf8"), false),
				"base64",
			).toString("utf8");
		if (process.platform === "linux")
			return await command("secret-tool", [
				"lookup",
				"service",
				"plinycode-cli",
				"account",
				"pliny",
			]);
	} catch {
		/* Missing storage is normal on CI and first launch. */
	}
	throw new CliError(
		"missing_credentials",
		"Set PLINY_API_KEY or run plinycode auth login.",
	);
}

export async function saveApiKey(key: string): Promise<void> {
	if (!key.trim())
		throw new CliError("invalid_credentials", "The API key is empty.");
	if (process.platform === "win32") {
		const encrypted = await dpapi(
			Buffer.from(key.trim()).toString("base64"),
			true,
		);
		await mkdir(dirname(credentialPath()), { recursive: true });
		await writeFile(credentialPath(), encrypted, { mode: 0o600 });
	} else if (process.platform === "linux") {
		await command(
			"secret-tool",
			[
				"store",
				"--label=PlinyCode CLI",
				"service",
				"plinycode-cli",
				"account",
				"pliny",
			],
			key.trim(),
		);
	} else
		throw new CliError(
			"credential_store",
			"Use PLINY_API_KEY on this platform.",
		);
}

export async function removeApiKey(): Promise<void> {
	if (process.platform === "win32")
		await unlink(credentialPath()).catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		});
	else if (process.platform === "linux")
		await command("secret-tool", [
			"clear",
			"service",
			"plinycode-cli",
			"account",
			"pliny",
		]);
}

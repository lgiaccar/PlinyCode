import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "win32")(
	"Windows credentials round-trip through DPAPI in isolated storage",
	async () => {
		const parent = resolve(import.meta.dir, "../../../ai_output");
		await mkdir(parent, { recursive: true });
		const scratch = await mkdtemp(join(parent, "cli-credentials-"));
		const modulePath = resolve(import.meta.dir, "../src/credentials.ts");
		try {
			const script = `import {saveApiKey,getApiKey,removeApiKey} from ${JSON.stringify(modulePath)};
await saveApiKey("fixture-secret");
if (await getApiKey() !== "fixture-secret") throw new Error("Key did not round-trip");
const file = Bun.file(process.env.LOCALAPPDATA + "/PlinyCode/cli/credential.dpapi");
if ((await file.text()).includes("fixture-secret")) throw new Error("Unencrypted key");
await removeApiKey();
if (await file.exists()) throw new Error("Logout left a credential");`;
			const child = Bun.spawn([process.execPath, "-e", script], {
				env: { ...process.env, PLINY_API_KEY: "", LOCALAPPDATA: scratch },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, output, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(error).toBe("");
			expect(code).toBe(0);
			expect(output).toBe("");
		} finally {
			await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
		}
	},
	20000,
);

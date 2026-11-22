/** Real NSIS self-update through the visible controls. Only run from installer.ps1 in a clean account. */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron } from "playwright";

const directory = dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.PLINY_DESKTOP_EXECUTABLE;
const data = process.env.PLINY_DESKTOP_UPGRADE_DATA;
const target = process.env.PLINY_DESKTOP_UPDATE_TARGET;
if (!executablePath || !data || !target)
	throw new Error("Isolated update installer fixture is not configured.");
const version = JSON.parse(
	await readFile(resolve(directory, "../package.json"), "utf8"),
).version as string;
const metadata = await readFile(join(dirname(target), "latest.yml"), "utf8");
let corrupt = true;
let binaries = 0;
const server = createServer(async (request, response) => {
	const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	if (path === "/feed/latest.yml") {
		response.end(metadata);
		return;
	}
	if (path !== `/feed/PlinyCode-Desktop-Setup-${version}-x64.exe`) {
		response.writeHead(404);
		response.end();
		return;
	}
	binaries++;
	if (corrupt) {
		response.end("corrupted installer");
		return;
	}
	response.writeHead(200, { "Content-Length": (await stat(target)).size });
	createReadStream(target).pipe(response);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No fixture port");
const env: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([, value]) => value !== undefined),
	),
	PLINY_DESKTOP_UPDATE_FIXTURE: `http://127.0.0.1:${address.port}/feed/`,
	PLINY_DESKTOP_DATA: join(data, "state"),
	PLINY_DESKTOP_TEST_PROJECT: join(data, "project"),
	PLINY_API_KEY: "update-fixture-key",
	GIT_CEILING_DIRECTORIES: data,
};
delete env.ELECTRON_RUN_AS_NODE;
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
	await promisify(execFile)(
		process.execPath,
		["--experimental-strip-types", resolve(directory, "upgrade.ts"), "seed"],
		{ env, timeout: 90_000, windowsHide: true },
	);
	application = await _electron.launch({
		executablePath,
		args: [],
		env,
		timeout: 40_000,
	});
	const page = await application.firstWindow();
	await page
		.getByRole("button", { name: "Check for updates", exact: true })
		.click();
	await page
		.getByRole("button", { name: `Download ${version}`, exact: true })
		.waitFor();
	assert.equal(binaries, 0, "Checking must not download or install an update");
	await page
		.getByRole("button", { name: `Download ${version}`, exact: true })
		.click();
	await page
		.getByText(
			"Download failed or its checksum did not match. Check again to retry.",
			{ exact: true },
		)
		.waitFor();
	assert.equal(
		await page
			.getByRole("button", {
				name: `Install ${version} and restart`,
				exact: true,
			})
			.count(),
		0,
	);
	corrupt = false;
	await page
		.getByRole("button", { name: "Check for updates", exact: true })
		.click();
	await page
		.getByRole("button", { name: `Download ${version}`, exact: true })
		.click();
	await page
		.getByRole("button", {
			name: `Install ${version} and restart`,
			exact: true,
		})
		.waitFor({ timeout: 90_000 });
	assert.ok(binaries >= 2, "A failed digest must cause a fresh download");
	await page.screenshot({ path: join(data, "update-ready.png") });
	console.log(
		"PASS: real updater rejects corrupt installer, retries verified download, and requires explicit install",
	);
	if (!process.argv.includes("--download-only")) {
		const exited = new Promise<void>((resolve) =>
			application?.process().once("exit", () => resolve()),
		);
		await page
			.getByRole("button", {
				name: `Install ${version} and restart`,
				exact: true,
			})
			.click();
		let timeout: ReturnType<typeof setTimeout>;
		try {
			await Promise.race([
				exited,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error("Updater did not exit the old app")),
						60_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timeout!);
		}
		console.log(
			"PASS: updater handed the verified installer to NSIS and exited the old app",
		);
	}
} catch (error) {
	const page = application?.windows()[0];
	if (page) {
		console.error(
			"Update UI:",
			await page.locator(".desktop-updates").allTextContents(),
		);
		await page
			.screenshot({ path: join(data, "self-update-failure.png") })
			.catch(() => {});
	}
	throw error;
} finally {
	await application?.close().catch(() => {});
	server.closeAllConnections();
	server.close();
}

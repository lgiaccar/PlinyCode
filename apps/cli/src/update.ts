import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	extractPackage,
	verifyChecksum,
	verifyPackage,
} from "./update-archive";
import { assetName, assetURL, download, findRelease } from "./update-feed";
import {
	compareVersions,
	packageInfo,
	readState,
	slotPath,
	writeState,
} from "./update-layout";
import { CLI_VERSION } from "./version";

const platform = process.platform === "win32" ? "windows" : "linux";
async function installationRoot(): Promise<string> {
	const root = await realpath(
		process.env.PLINYCODE_INSTALL_ROOT || import.meta.dir,
	);
	await packageInfo(root);
	const current = await slotPath(root, (await readState(root)).current);
	if (resolve(current) !== resolve(await realpath(import.meta.dir)))
		throw new Error(
			"Run update through the active installation's plinycode launcher.",
		);
	if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform))
		throw new Error("Self-update supports Windows and Linux x64 only.");
	return root;
}
export async function acquireUpdateLock(
	root: string,
): Promise<() => Promise<void>> {
	const directory = join(root, ".update-lock");
	const recovery = join(root, ".update-recovery");
	try {
		await lstat(recovery);
		throw new Error(
			"Update lock recovery is in progress. Retry after it finishes; if interrupted, inspect .update-recovery before removing it.",
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		await mkdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST")
			throw new Error(
				"Cannot write to this installation. Move the entire CLI folder to a user-writable location.",
			);
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("Invalid update lock directory.");
		let stale = false;
		try {
			const owner = JSON.parse(
				await readFile(join(directory, "owner.json"), "utf8"),
			);
			if (!Number.isInteger(owner.pid) || owner.pid <= 0)
				throw new Error("Invalid lock owner");
			try {
				process.kill(owner.pid, 0);
			} catch (error) {
				stale = (error as NodeJS.ErrnoException).code === "ESRCH";
			}
		} catch {
			stale = Date.now() - stat.mtimeMs > 600000;
		}
		if (!stale)
			throw new Error("Another CLI update is running. Wait for it to finish.");
		// Rename before removal: only one contender can recover a stale lock.
		const abandoned = join(root, `.abandoned-lock-${randomUUID()}`);
		await mkdir(recovery);
		try {
			// A competing recovery may have replaced the owner since our first read.
			const owner = JSON.parse(
				await readFile(join(directory, "owner.json"), "utf8").catch(() => "{}"),
			);
			if (Number.isInteger(owner.pid) && owner.pid > 0) {
				try {
					process.kill(owner.pid, 0);
					throw new Error("Another CLI update is running.");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			} else if (Date.now() - (await lstat(directory)).mtimeMs <= 600000)
				throw new Error("Another CLI update is starting.");
			await rename(directory, abandoned);
			await rm(abandoned, { recursive: true });
		} finally {
			await rm(recovery, { recursive: true });
		}
		return acquireUpdateLock(root);
	}
	try {
		await writeFile(
			join(directory, "owner.json"),
			JSON.stringify({ pid: process.pid }),
			{ flag: "wx" },
		);
	} catch (error) {
		await rm(directory, { recursive: true });
		throw error;
	}
	return () => rm(directory, { recursive: true });
}
async function healthCheck(directory: string, version: string): Promise<void> {
	const child = Bun.spawn(
		[
			join(directory, "runtime", platform === "windows" ? "bun.exe" : "bun"),
			join(directory, "plinycode.js"),
			"--version",
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PLINYCODE_UPDATE_NOTIFY: "0" },
		},
	);
	const timer = setTimeout(() => child.kill(), 15000);
	try {
		const [status, output] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (status !== 0 || output.trim() !== version)
			throw new Error(
				"New CLI failed its startup check. The active version is unchanged.",
			);
	} finally {
		clearTimeout(timer);
	}
}
export async function runUpdate(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		strict: true,
		allowPositionals: true,
		options: {
			check: { type: "boolean" },
			rollback: { type: "boolean" },
			version: { type: "string" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"plinycode update [--check | --rollback | --version <stable-version>] [--json]\nInstall verified updates explicitly; --rollback restores the previous local version.\n",
		);
		return;
	}
	if (
		positionals.length ||
		Number(!!values.check) +
			Number(!!values.rollback) +
			Number(!!values.version) >
			1
	)
		throw new Error(
			"Choose update, update --check, update --version <version>, or update --rollback.",
		);
	const report = (data: Record<string, unknown>, message: string) =>
		process.stdout.write(
			values.json ? `${JSON.stringify(data)}\n` : `${message}\n`,
		);
	if (values.check) {
		const release = await findRelease();
		const latest = release.tag_name.slice(5);
		report(
			{
				current: CLI_VERSION,
				latest,
				available: compareVersions(latest, CLI_VERSION) > 0,
			},
			compareVersions(latest, CLI_VERSION) > 0
				? `CLI ${latest} is available (current ${CLI_VERSION}). Run plinycode update.`
				: `CLI ${CLI_VERSION} is up to date (latest published ${latest}).`,
		);
		return;
	}
	const root = await installationRoot();
	const unlock = await acquireUpdateLock(root);
	let staging: string | undefined;
	try {
		// Recheck after acquiring the lock: another process may have switched versions.
		if (
			resolve(await slotPath(root, (await readState(root)).current)) !==
			resolve(await realpath(import.meta.dir))
		)
			throw new Error(
				"The active version changed. Run the command again through plinycode.",
			);
		const state = await readState(root);
		if (values.rollback) {
			if (!state.previous)
				throw new Error("No previous version is available for rollback.");
			const previous = await slotPath(root, state.previous);
			const info = await packageInfo(previous);
			await verifyPackage(previous, platform);
			await healthCheck(previous, info.version);
			await writeState(root, {
				current: state.previous,
				previous: state.current,
			});
			report(
				{ status: "rolled_back", version: info.version },
				`Rolled back to CLI ${info.version}. New invocations use this version; running tasks are unchanged.`,
			);
			return;
		}
		const release = await findRelease(values.version);
		const version = release.tag_name.slice(5);
		if (
			(!values.version && compareVersions(version, CLI_VERSION) <= 0) ||
			version === CLI_VERSION
		) {
			report(
				{ status: "up_to_date", version: CLI_VERSION },
				`CLI ${CLI_VERSION} is already up to date.`,
			);
			return;
		}
		const name = assetName(version, platform);
		const checksums = (
			await download(assetURL(release, "SHA256SUMS"), 1_000_000)
		).toString();
		const archive = await download(assetURL(release, name), 200 * 1024 * 1024);
		verifyChecksum(archive, checksums, name);
		staging = join(root, `.update-stage-${randomUUID()}`);
		await mkdir(staging);
		const candidate = await extractPackage(archive, staging, platform);
		if ((await packageInfo(candidate)).version !== version)
			throw new Error("Release and package versions do not match.");
		await healthCheck(candidate, version);
		const versions = join(root, "versions");
		await mkdir(versions, { recursive: true });
		const stat = await lstat(versions);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("Versions directory must not be a link.");
		const slot = `versions/${version}-${randomUUID()}`;
		await rename(candidate, join(root, slot));
		await writeState(root, { current: slot, previous: state.current });
		report(
			{ status: "updated", version, previous: CLI_VERSION },
			`Updated to CLI ${version}. Run plinycode --version to verify; use plinycode update --rollback to undo.`,
		);
	} finally {
		// Only our unique staging directory is removed. Installed versions and user files are retained.
		if (staging)
			await rm(staging, { recursive: true, force: true }).catch(() =>
				process.stderr.write("Update staging cleanup was deferred.\n"),
			);
		await unlock().catch(() =>
			process.stderr.write(
				"Update lock cleanup was deferred; it will be recovered on the next attempt.\n",
			),
		);
	}
}
export async function notifyUpdate(): Promise<void> {
	if (process.env.PLINYCODE_UPDATE_NOTIFY !== "1") return;
	try {
		const root = await installationRoot();
		const cache = join(root, ".update-check.json");
		try {
			if (
				Date.now() - JSON.parse(await readFile(cache, "utf8")).checkedAt <
				86400000
			)
				return;
		} catch {}
		await writeFile(cache, JSON.stringify({ checkedAt: Date.now() }));
		const release = await findRelease();
		const version = release.tag_name.slice(5);
		if (compareVersions(version, CLI_VERSION) > 0)
			process.stderr.write(
				`\nPlinyCode CLI ${version} is available. Run plinycode update to install.\n`,
			);
	} catch {
		/* Optional notifications must never prevent chat or expose network errors. */
	}
}

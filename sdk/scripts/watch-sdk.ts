#!/usr/bin/env bun

/**
 * Rebuilds the engine packages (sdk/packages/shared, llms, core) when their
 * source changes, so the extension picks up engine edits without a manual
 * `bun run build:sdk`.
 *
 * The packages resolve each other through compiled `dist/` (no `development`
 * source condition), so they must build in dependency order: a change in
 * `shared` rebuilds `shared`, then `llms`, then `core`; a change in `llms`
 * rebuilds `llms` and `core`; a change in `core` rebuilds `core` alone. Each
 * rebuild runs the package's own `build` script (a `Bun.build` bundle, plus
 * `tsc --emitDeclarationOnly` where the package ships declarations), so it
 * produces exactly what `bun run build:sdk` produces.
 *
 * Changes that arrive while a build runs are queued and built afterwards. Test
 * files are ignored. The running extension host does not reload `dist/`:
 * restart the debug session (or reload the window) after a rebuild.
 *
 * Usage:
 *   bun run watch:sdk            # watch only; assumes dist/ exists (bun run build:sdk)
 *   bun run watch:sdk --initial  # build all packages first, then watch
 *
 * The `[watch:sdk] build started` / `[watch:sdk] build finished` /
 * `[watch:sdk] build failed` lines are what the `npm: watch:sdk` task in
 * .vscode/tasks.json matches to know when a rebuild is in flight.
 */

import { type FSWatcher, watch } from "node:fs";
import path from "node:path";

type PackageName = "shared" | "llms" | "core";

// Build order; `dependents` are rebuilt after the package itself.
const PACKAGES: ReadonlyArray<{
	name: PackageName;
	dependents: PackageName[];
}> = [
	{ name: "shared", dependents: ["llms", "core"] },
	{ name: "llms", dependents: ["core"] },
	{ name: "core", dependents: [] },
];

// Watched inside each package directory. `dist/` and `node_modules/` are not.
const WATCHED_ENTRIES = [
	"src",
	"bun.mts",
	"package.json",
	"tsconfig.json",
	"tsconfig.build.json",
];
const IGNORED_FILE = /\.test\.(ts|tsx|mts)$|\.e2e\./;
const DEBOUNCE_MS = 300;

const root = path.resolve(import.meta.dir, "..", "..");
const packagesDir = path.join(root, "sdk", "packages");
const buildOrder = PACKAGES.map((p) => p.name);

const dirty = new Set<PackageName>();
let debounce: ReturnType<typeof setTimeout> | undefined;
let building = false;

function log(message: string): void {
	console.log(`[watch:sdk] ${message}`);
}

function markDirty(name: PackageName): void {
	dirty.add(name);
	for (const dependent of PACKAGES.find((p) => p.name === name)?.dependents ??
		[]) {
		dirty.add(dependent);
	}
}

async function buildPackage(name: PackageName): Promise<boolean> {
	const started = Date.now();
	const proc = Bun.spawn(["bun", "run", "build"], {
		cwd: path.join(packagesDir, name),
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	const code = await proc.exited;
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (code !== 0) {
		log(`@plinycode/${name} failed (exit ${code}) after ${seconds}s`);
		return false;
	}
	log(`@plinycode/${name} built in ${seconds}s`);
	return true;
}

async function buildDirty(): Promise<void> {
	if (building) {
		return;
	}
	building = true;
	try {
		while (dirty.size > 0) {
			const batch = buildOrder.filter((name) => dirty.has(name));
			dirty.clear();
			log(`build started (${batch.join(", ")})`);
			let ok = true;
			for (const name of batch) {
				if (!(await buildPackage(name))) {
					ok = false;
					break;
				}
			}
			log(ok ? "build finished" : "build failed");
		}
	} finally {
		building = false;
	}
}

function scheduleBuild(): void {
	if (debounce) {
		clearTimeout(debounce);
	}
	debounce = setTimeout(() => {
		debounce = undefined;
		void buildDirty();
	}, DEBOUNCE_MS);
}

function watchPackage(name: PackageName): FSWatcher[] {
	const watchers: FSWatcher[] = [];
	for (const entry of WATCHED_ENTRIES) {
		const target = path.join(packagesDir, name, entry);
		const isDir = entry === "src";
		try {
			const watcher = watch(
				target,
				{ recursive: isDir, persistent: true },
				(_event, filename) => {
					const changed = filename ? String(filename) : entry;
					if (IGNORED_FILE.test(changed)) {
						return;
					}
					log(`${name}: ${changed.split(path.sep).join("/")}`);
					markDirty(name);
					scheduleBuild();
				},
			);
			watcher.on("error", (error) => {
				log(`watcher error on ${target}: ${String(error)}`);
			});
			watchers.push(watcher);
		} catch (error) {
			log(`cannot watch ${target}: ${String(error)}`);
		}
	}
	return watchers;
}

async function main(): Promise<void> {
	if (process.argv.includes("--initial")) {
		for (const name of buildOrder) {
			markDirty(name);
		}
		await buildDirty();
	}
	const watchers = PACKAGES.flatMap((p) => watchPackage(p.name));
	log(
		`watching ${buildOrder.map((n) => `sdk/packages/${n}`).join(", ")} (Ctrl+C to stop)`,
	);
	const stop = () => {
		for (const watcher of watchers) {
			watcher.close();
		}
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

await main();

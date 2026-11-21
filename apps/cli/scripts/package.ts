import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	cp,
	mkdir,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "../..");
const { version } = JSON.parse(
	await readFile(join(root, "package.json"), "utf8"),
);
const pin = (await readFile(join(repo, ".tool-versions"), "utf8")).match(
	/^bun\s+(\S+)/m,
)?.[1];
if (Bun.version !== pin)
	throw new Error(`Package with pinned Bun ${pin}, not ${Bun.version}.`);
if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform))
	throw new Error("Package on Windows x64 or Linux x64.");
await import("./build");
if (process.exitCode) throw new Error("Build failed.");
const platform = process.platform === "win32" ? "windows" : "linux";
const destination = join(root, "dist", `plinycode-${platform}-x64`);
await mkdir(join(destination, "runtime"), { recursive: true });
const runtime = join(
	destination,
	"runtime",
	platform === "windows" ? "bun.exe" : "bun",
);
await copyFile(process.execPath, runtime);
await copyFile(
	join(root, "dist/plinycode.js"),
	join(destination, "plinycode.js"),
);
await writeFile(
	join(destination, "README.md"),
	(await readFile(join(repo, "docs/cli.md"), "utf8"))
		.replaceAll("(cli-install.md)", "(INSTALL.md)")
		.replaceAll("../apps/cli/examples/", "examples/"),
);
await writeFile(
	join(destination, "INSTALL.md"),
	(await readFile(join(repo, "docs/cli-install.md"), "utf8"))
		.replaceAll("0.1.0", version)
		.replaceAll("(cli.md)", "(README.md)"),
);
await cp(join(root, "examples"), join(destination, "examples"), {
	recursive: true,
});
await copyFile(join(repo, "LICENSE"), join(destination, "LICENSE"));
await copyFile(
	join(root, "assets/BUN-LICENSE.txt"),
	join(destination, "BUN-LICENSE.txt"),
);

// Include notices for the installed production dependency closure (a superset
// of tree-shaken modules), resolving Bun workspace and cache symlinks.
const visited = new Set<string>();
const notices: string[] = [];
async function collectNotices(directory: string): Promise<void> {
	const actual = await realpath(directory);
	if (visited.has(actual)) return;
	visited.add(actual);
	const pkg = JSON.parse(await readFile(join(actual, "package.json"), "utf8"));
	for (const file of (await readdir(actual)).filter((name) =>
		/^(license|licence|notice)(\.|$)/i.test(name),
	)) {
		const text = await readFile(join(actual, file), "utf8").catch(() => "");
		if (text) notices.push(`${pkg.name}@${pkg.version} — ${file}\n${text}`);
	}
	for (const dependency of Object.keys({
		...pkg.dependencies,
		...pkg.optionalDependencies,
	}).sort()) {
		let parent = actual;
		while (true) {
			const candidate = join(parent, "node_modules", dependency);
			if (await Bun.file(join(candidate, "package.json")).exists()) {
				await collectNotices(candidate);
				break;
			}
			if (dirname(parent) === parent) break;
			parent = dirname(parent);
		}
	}
}
await collectNotices(root);
await writeFile(
	join(destination, "THIRD-PARTY-NOTICES.txt"),
	notices.join("\n\n----------------------------------------\n\n"),
);
const launcher = platform === "windows" ? "plinycode.cmd" : "plinycode";
await writeFile(
	join(destination, launcher),
	platform === "windows"
		? '@echo off\r\n"%~dp0runtime\\bun.exe" --use-system-ca "%~dp0plinycode.js" %*\r\nexit /b %errorlevel%\r\n'
		: '#!/bin/sh\ncli_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$cli_dir/runtime/bun" --use-system-ca "$cli_dir/plinycode.js" "$@"\n',
);
await chmod(runtime, 0o755);
await chmod(join(destination, launcher), 0o755);
if (platform === "windows") {
	// Git Bash resolves the extensionless shell launcher; PowerShell uses .cmd.
	await writeFile(
		join(destination, "plinycode"),
		'#!/bin/sh\ncli_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$cli_dir/runtime/bun.exe" --use-system-ca "$cli_dir/plinycode.js" "$@"\n',
	);
	await chmod(join(destination, "plinycode"), 0o755);
}
const files = [
	"plinycode.js",
	launcher,
	`runtime/${platform === "windows" ? "bun.exe" : "bun"}`,
	"README.md",
	"INSTALL.md",
	"LICENSE",
	"BUN-LICENSE.txt",
	"THIRD-PARTY-NOTICES.txt",
	"examples/analyse.py",
	"examples/judgement.schema.json",
];
if (platform === "windows") files.push("plinycode");
const hashes = await Promise.all(
	files.map(
		async (file) =>
			`${createHash("sha256")
				.update(await readFile(join(destination, file)))
				.digest("hex")}  ${file}`,
	),
);
await writeFile(join(destination, "SHA256SUMS"), `${hashes.join("\n")}\n`);
console.log(destination);

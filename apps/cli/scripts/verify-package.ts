import { join, resolve } from "node:path";
import { version } from "../package.json";

const destination = resolve(
	import.meta.dir,
	`../dist/plinycode-${process.platform === "win32" ? "windows" : "linux"}-x64`,
);
const runtime = join(
	destination,
	"runtime",
	process.platform === "win32" ? "bun.exe" : "bun",
);
const entry = join(destination, "plinycode.js");
const command =
	process.platform === "win32"
		? [
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
				"/d",
				"/c",
				join(destination, "plinycode.cmd"),
				"--help",
			]
		: [join(destination, "plinycode"), "--help"];
const help = Bun.spawn(command, {
	env: {
		...process.env,
		PATH: process.platform === "win32" ? "" : "/usr/bin:/bin",
	},
	stdout: "pipe",
	stderr: "pipe",
});
const [output, errors, status] = await Promise.all([
	new Response(help.stdout).text(),
	new Response(help.stderr).text(),
	help.exited,
]);
if (status !== 0 || !output.includes("PlinyCode CLI"))
	throw new Error(`Packaged launcher failed: ${output}\n${errors}`);

const metadata = await Bun.file(join(destination, "cli-package.json")).json();
if (metadata.version !== version || metadata.updateLayout !== 1)
	throw new Error("Invalid packaged update metadata.");
const versionProbe = Bun.spawn([runtime, entry, "--version"], {
	stdout: "pipe",
	stderr: "pipe",
});
if (
	(await new Response(versionProbe.stdout).text()).trim() !== version ||
	(await versionProbe.exited) !== 0
)
	throw new Error("Packaged CLI version mismatch.");
if ((await Bun.file(entry).text()).includes("http://127.0.0.1:47835/releases"))
	throw new Error("Updater test feed leaked into release bundle.");

// Exercise inference, tools and validation from the bundle, not workspace imports.
const tests = Bun.spawn(
	[process.execPath, "test", "apps/cli/tests/pipeline.test.ts"],
	{
		cwd: resolve(import.meta.dir, "../../.."),
		env: {
			...process.env,
			PLINYCODE_TEST_ENTRY: entry,
			PLINYCODE_TEST_RUNTIME: runtime,
		},
		stdout: "inherit",
		stderr: "inherit",
	},
);
if ((await tests.exited) !== 0)
	throw new Error("Packaged integration tests failed.");

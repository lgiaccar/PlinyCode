import { join, resolve } from "node:path";

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

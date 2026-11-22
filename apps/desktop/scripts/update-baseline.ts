import { resolve } from "node:path";

// Unpublished fixture only. The production installer is built before this script.
if (process.platform !== "win32")
	throw new Error("Windows installer update fixture only.");
const directory = resolve(import.meta.dir, "..");
const output = resolve(directory, "../../ai_output/updater-baseline");
async function run(args: string[], testBuild = false) {
	const result = await Bun.spawn([process.execPath, ...args], {
		cwd: directory,
		env: {
			...process.env,
			PLINY_DESKTOP_UPDATE_TEST_BUILD: testBuild ? "1" : "0",
		},
		stdout: "inherit",
		stderr: "inherit",
	}).exited;
	if (result) throw new Error(`Update fixture build failed: ${args.join(" ")}`);
}
try {
	await run(["run", "build"], true);
	await run([
		"run",
		"electron-builder",
		"--win",
		"nsis",
		"--x64",
		"--publish",
		"never",
		"--config.extraMetadata.version=0.0.0",
		`--config.directories.output=${output}`,
	]);
} finally {
	await run(["run", "build"]); // Restore the normal development bundle, without fixture overrides.
}

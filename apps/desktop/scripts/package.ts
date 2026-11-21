// Native builds are mandatory: build.ts bundles the current Bun executable.
const version = (await Bun.file(`${import.meta.dir}/../package.json`).json())
	.version;
const platform = process.argv[2];
if (!(["linux", "win32"].includes(platform) && process.platform === platform))
	throw new Error(
		`Build ${platform} packages on a ${platform} host so the bundled runtime matches.`,
	);
if (process.arch !== "x64")
	throw new Error("Desktop packages currently target x64 only.");
for (const args of [
	["run", "build"],
	["scripts/notices.ts"],
	[
		"run",
		"electron-builder",
		...(platform === "linux"
			? ["--linux", "deb", "AppImage"]
			: ["--win", "nsis"]),
		"--x64",
		`--config.publish.url=https://github.com/lgiaccar/PlinyCode/releases/download/desktop-v${version}/`,
		"--publish",
		"never",
	],
]) {
	const result = await Bun.spawn([process.execPath, ...args], {
		cwd: `${import.meta.dir}/..`,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).exited;
	if (result !== 0) process.exit(result);
}

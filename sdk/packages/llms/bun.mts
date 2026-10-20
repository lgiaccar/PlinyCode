/// <reference types="@types/bun" />
export {};

type PackageManifest = {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const packageJson = (await Bun.file(
	new URL("./package.json", import.meta.url),
).json()) as PackageManifest;
const sourcemap = Bun.env.CLINE_SOURCEMAPS === "1" ? "linked" : "none";
// minify: true keeps identifier mangling active even when sourcemaps are enabled.
const minify = Bun.env.CLINE_SOURCEMAPS !== "1";

// Every declared runtime dependency stays external, @plinycode/shared included:
// bundling it gave this package its own copy of shared's process-wide state
// (the token calibration the providers teach and the engine reads), so the
// engine never saw an observation. scripts/verify-externals.ts checks the
// output still imports it.
const external = Object.keys({
	...(packageJson.dependencies ?? {}),
	...(packageJson.peerDependencies ?? {}),
});

const builds: Parameters<typeof Bun.build>[0][] = [
	{
		entrypoints: ["./src/index.ts", "./src/models.ts", "./src/providers.ts"],
		outdir: "./dist",
		target: "node",
		external,
		packages: "bundle",
		minify,
		sourcemap,
	},
	{
		entrypoints: ["./src/index.browser.ts", "./src/providers.browser.ts"],
		outdir: "./dist",
		target: "browser",
		external,
		packages: "bundle",
		minify,
		sourcemap,
	},
];

for (const config of builds) {
	const result = await Bun.build(config);

	if (result.logs.length > 0) {
		for (const log of result.logs) {
			console.warn(log);
		}
	}
}

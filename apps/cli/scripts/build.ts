import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const result = await Bun.build({
	entrypoints: [resolve(root, "src/main.ts")],
	outdir: resolve(root, "dist"),
	naming: "plinycode.js",
	target: "bun",
	minify: false,
	sourcemap: "external",
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exitCode = 1;
}

import { resolve } from "node:path";
import { version } from "../package.json";

const root = resolve(import.meta.dir, "..");
const fixture = process.env.PLINYCODE_UPDATER_FIXTURE === "1";
const outdir = fixture
	? resolve(root, "../../ai_output/updater-fixture")
	: resolve(root, "dist");
for (const entry of fixture ? ["main"] : ["main", "launcher"]) {
	const result = await Bun.build({
		entrypoints: [resolve(root, `src/${entry}.ts`)],
		outdir,
		naming: entry === "main" ? "plinycode.js" : "launcher.js",
		target: "bun",
		minify: false,
		sourcemap: "external",
		define: {
			PLINYCODE_CLI_VERSION: JSON.stringify(fixture ? "0.0.0" : version),
			PLINYCODE_UPDATE_TEST_FEED: JSON.stringify(
				fixture ? "http://127.0.0.1:47835/releases" : "",
			),
		},
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exitCode = 1;
	}
}

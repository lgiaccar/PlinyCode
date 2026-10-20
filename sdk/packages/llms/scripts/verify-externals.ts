import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The llms bundle must import `@plinycode/shared` rather than carry a copy of
 * it. Shared holds process-wide state (the token calibration the provider
 * layer teaches and the engine reads and persists); a bundled copy made two
 * of it, and the engine never saw what the providers learned.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTERNAL_IMPORT = /from\s*["']@plinycode\/shared(?:\/[^"']*)?["']/;

for (const file of ["dist/index.js", "dist/index.browser.js"]) {
	const source = readFileSync(join(packageRoot, file), "utf8");
	if (!EXTERNAL_IMPORT.test(source)) {
		console.error(
			`${file} does not import @plinycode/shared: the package was bundled into it. Keep @plinycode/* external in bun.mts.`,
		);
		process.exit(1);
	}
}

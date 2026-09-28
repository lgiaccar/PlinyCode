import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const corePackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every public subpath must ship both its runtime file and its declarations.
const manifest = JSON.parse(
	readFileSync(join(corePackageRoot, "package.json"), "utf8"),
) as { exports: Record<string, { types: string; import: string }> };
for (const entry of Object.values(manifest.exports)) {
	for (const path of [entry.types, entry.import])
		readFileSync(join(corePackageRoot, path));
}

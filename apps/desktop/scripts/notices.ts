import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Include the installed production dependency closure, a superset of the
// tree-shaken bundle. Resolve Bun/workspace symlinks before visiting packages.
const root = resolve(import.meta.dir, "..");
const output = join(root, "dist", "licenses");
await mkdir(output, { recursive: true });
await copyFile(
	join(root, "../../LICENSE"),
	join(output, "PLINYCODE-LICENSE.txt"),
);
await copyFile(
	join(root, "../cli/assets/BUN-LICENSE.txt"),
	join(output, "BUN-LICENSE.txt"),
);
const visited = new Set<string>(),
	notices: string[] = [];
async function collect(directory: string): Promise<void> {
	const actual = await realpath(directory);
	if (visited.has(actual)) return;
	visited.add(actual);
	const pkg = JSON.parse(await readFile(join(actual, "package.json"), "utf8"));
	notices.push(
		`${pkg.name}@${pkg.version}\nLicense: ${typeof pkg.license === "string" ? pkg.license : "See package license below"}`,
	);
	for (const file of (await readdir(actual)).filter((name) =>
		/^(license|licence|notice)(\.|$)/i.test(name),
	)) {
		const text = await readFile(join(actual, file), "utf8").catch(() => "");
		if (text) notices.push(`${pkg.name}@${pkg.version} - ${file}\n${text}`);
	}
	for (const dependency of Object.keys({
		...pkg.dependencies,
		...pkg.optionalDependencies,
	}).sort()) {
		let parent = actual;
		while (true) {
			const candidate = join(parent, "node_modules", dependency);
			if (await Bun.file(join(candidate, "package.json")).exists()) {
				await collect(candidate);
				break;
			}
			if (dirname(parent) === parent) break;
			parent = dirname(parent);
		}
	}
}
await collect(root);
await writeFile(
	join(output, "THIRD-PARTY-NOTICES.txt"),
	notices.join("\n\n----------------------------------------\n\n"),
);

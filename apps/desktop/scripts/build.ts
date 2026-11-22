import { chmod, copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist");
const version = JSON.parse(
	await readFile(join(root, "package.json"), "utf8"),
).version;
const pin = (
	await readFile(resolve(root, "../../.tool-versions"), "utf8")
).match(/^bun\s+(\S+)/m)?.[1];
if (Bun.version !== pin) throw new Error(`Build with Bun ${pin}.`);
await mkdir(join(out, "runtime"), { recursive: true });
for (const [entry, target, format, name] of [
	["main", "node", "cjs", "main.cjs"],
	["preload", "node", "cjs", "preload.cjs"],
	["worker", "bun", "esm", "worker.js"],
	["probe", "bun", "esm", "probe.js"],
	["command-worker", "bun", "esm", "command-worker.js"],
	["renderer", "browser", "esm", "renderer.js"],
] as const) {
	const result = await Bun.build({
		entrypoints: [
			join(root, `src/${entry}.${entry === "renderer" ? "tsx" : "ts"}`),
		],
		outdir: out,
		target,
		format,
		naming: name,
		external: target === "node" ? ["electron"] : [],
		define: {
			"process.env.NODE_ENV": '"production"',
			__PLINY_DESKTOP_RELEASE_VERSION__: JSON.stringify(version),
			__PLINY_UPDATE_TEST_BUILD__: String(
				process.env.PLINY_DESKTOP_UPDATE_TEST_BUILD === "1",
			),
		},
		minify: false,
	});
	if (!result.success)
		throw new AggregateError(result.logs, `${entry} build failed`);
}
await copyFile(
	process.execPath,
	join(out, "runtime", process.platform === "win32" ? "bun.exe" : "bun"),
);
if (process.platform !== "win32")
	await chmod(join(out, "runtime", "bun"), 0o755);
for (const file of ["index.html", "style.css"])
	await copyFile(join(root, "src", file), join(out, file));
console.log(`Built PlinyCode Desktop in ${out}`);
await cp(join(root, "browser-extension"), join(out, "browser-extension"), {
	recursive: true,
});

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { archiveName } from "./release-assets";

const root = resolve(import.meta.dir, "..");
const { version } = JSON.parse(
	await readFile(join(root, "package.json"), "utf8"),
);
if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform))
	throw new Error("Archive on Windows x64 or Linux x64.");
const platform = process.platform === "win32" ? "windows" : "linux";
const directory = `plinycode-${platform}-x64`;
const output = join(root, "dist/release");
await mkdir(output, { recursive: true });
const name = archiveName(version, platform);
const file = join(output, name);
const command =
	platform === "windows"
		? [
				"powershell.exe",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:PLINY_ARCHIVE_SOURCE -DestinationPath $env:PLINY_ARCHIVE_DESTINATION -Force",
			]
		: ["tar", "-czf", file, directory];
const result = await Bun.spawn(command, {
	cwd: join(root, "dist"),
	env: {
		...process.env,
		PLINY_ARCHIVE_SOURCE: join(root, "dist", directory),
		PLINY_ARCHIVE_DESTINATION: file,
	},
	stdout: "inherit",
	stderr: "inherit",
}).exited;
if (result !== 0) throw new Error("CLI archive creation failed.");
const hash = createHash("sha256")
	.update(await readFile(file))
	.digest("hex");
await writeFile(`${file}.sha256`, `${hash}  ${name}\n`);
console.log(file);

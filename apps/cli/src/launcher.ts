import { dirname, join } from "node:path";
import { readState, slotPath } from "./update-layout";

// Kept at the installation root. Never overwritten by update or rollback.
try {
	const root = import.meta.dir;
	const directory = await slotPath(root, (await readState(root)).current);
	const child = Bun.spawn(
		[
			join(
				directory,
				"runtime",
				process.platform === "win32" ? "bun.exe" : "bun",
			),
			"--use-system-ca",
			join(directory, "plinycode.js"),
			...process.argv.slice(2),
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				PLINYCODE_INSTALL_ROOT: dirname(import.meta.path),
			},
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			child.kill(signal);
		});
	process.exit(await child.exited);
} catch (error) {
	console.error(
		`PlinyCode launcher: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}

import { spawn } from "node:child_process";
import type { Interface } from "node:readline";

/** An app crash closes its pipes. Do not let a worker or command outlive it. */
export function guardHostLifetime(input: Interface): void {
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		if (process.platform === "win32") {
			const killer = spawn(
				"taskkill.exe",
				["/PID", String(process.pid), "/T", "/F"],
				{ windowsHide: true, stdio: "ignore" },
			);
			killer.once("error", () => process.exit(1));
			killer.once("close", () => process.exit(1));
		} else {
			try {
				process.kill(-process.pid, "SIGKILL");
			} catch {
				process.exit(1);
			}
		}
	};
	input.once("close", stop);
	process.stdout.once("error", stop);
	process.stderr.once("error", stop);
}

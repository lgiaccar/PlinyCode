/**
 * Locating a ripgrep binary, shared by the executors that run one.
 */

import { spawn } from "node:child_process";

/**
 * A ripgrep binary to prefer over `rg` on PATH, for hosts that ship one.
 * A function is called once, on first use; if it throws or the binary does
 * not run, `rg` on PATH is tried next.
 */
export type RipgrepPath =
	| string
	| (() => string | undefined | Promise<string | undefined>);

const rgRunnable = new Map<string, Promise<boolean>>();

function canRunRipgrep(command: string): Promise<boolean> {
	let known = rgRunnable.get(command);
	if (!known) {
		known = new Promise<boolean>((resolve) => {
			const child = spawn(command, ["--version"], {
				stdio: ["ignore", "pipe", "pipe"],
				// Prevent a console window from flashing on Windows.
				windowsHide: true,
			});
			const timeout = setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGTERM");
				}
				resolve(false);
			}, 1000);
			child.on("close", (code) => {
				clearTimeout(timeout);
				resolve(code === 0);
			});
			child.on("error", () => {
				clearTimeout(timeout);
				resolve(false);
			});
		});
		rgRunnable.set(command, known);
	}
	return known;
}

/**
 * Returns a function that resolves, once, to the ripgrep command to run, or
 * to null when none works and the caller should use its own fallback.
 */
export function createRipgrepResolver(
	rgPath: RipgrepPath | undefined,
): () => Promise<string | null> {
	let resolved: Promise<string | null> | undefined;
	return () => {
		resolved ??= (async () => {
			const preferred = await Promise.resolve(
				typeof rgPath === "function" ? rgPath() : rgPath,
			).catch(() => undefined);
			for (const command of [preferred, "rg"]) {
				if (command && (await canRunRipgrep(command))) {
					return command;
				}
			}
			return null;
		})();
		return resolved;
	};
}

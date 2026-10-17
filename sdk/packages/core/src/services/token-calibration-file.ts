import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	tokenCalibration as defaultCalibration,
	type TokenCalibration,
} from "@plinycode/shared";

/** File name of the saved calibration, in the host's data directory. */
export const TOKEN_CALIBRATION_FILE_NAME = "token-calibration.json";

/** How long after an observation the file is written; observations in between share the write. */
const DEFAULT_SAVE_DELAY_MS = 5_000;

export interface TokenCalibrationPersistenceOptions {
	/** The calibration to load into and save from; the engine's process-wide one by default. */
	calibration?: TokenCalibration;
	saveDelayMs?: number;
	onError?: (error: unknown) => void;
}

function readSnapshot(filePath: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		// Missing or unreadable: start from what is in memory.
		return undefined;
	}
}

/**
 * Keep the per-model token calibration in `filePath` across reloads: load it
 * now, and write it a few seconds after calls teach it something. A write
 * first merges the file (another window may have saved newer entries), so
 * each model keeps its most recently observed ratio. Returns a disposer
 * that writes any pending change and stops saving.
 */
export function persistTokenCalibration(
	filePath: string,
	options: TokenCalibrationPersistenceOptions = {},
): () => void {
	const calibration = options.calibration ?? defaultCalibration;
	const saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
	calibration.load(readSnapshot(filePath));

	let timer: ReturnType<typeof setTimeout> | undefined;
	const save = () => {
		timer = undefined;
		try {
			calibration.load(readSnapshot(filePath));
			mkdirSync(dirname(filePath), { recursive: true });
			const temporary = `${filePath}.${process.pid}.tmp`;
			writeFileSync(
				temporary,
				`${JSON.stringify(calibration.snapshot(), null, 2)}\n`,
				"utf8",
			);
			renameSync(temporary, filePath);
		} catch (error) {
			options.onError?.(error);
		}
	};
	const unsubscribe = calibration.subscribe(() => {
		if (timer) {
			return;
		}
		timer = setTimeout(save, saveDelayMs);
		// A pending save must not keep the process alive.
		timer.unref?.();
	});
	return () => {
		unsubscribe();
		if (timer) {
			clearTimeout(timer);
			save();
		}
	};
}

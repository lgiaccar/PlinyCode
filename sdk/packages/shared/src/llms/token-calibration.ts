/**
 * A per-model characters-per-token ratio learned from the input token counts
 * providers report. The fixed CHARS_PER_TOKEN of 3 over-counts English and
 * code on most tokenizers (compaction then runs early) and under-counts dense
 * content on some; after each call that reports real usage, the ratio of the
 * request's estimated characters to the reported input tokens is folded into
 * an exponential moving average for that model.
 *
 * The store is process-wide (`tokenCalibration`) and holds no I/O: the host
 * loads and saves it (core's `persistTokenCalibration`). A model with fewer
 * than MIN_CALIBRATION_SAMPLES observations, or none, reads as
 * CHARS_PER_TOKEN.
 */

import { CHARS_PER_TOKEN } from "./tokens";

/** Lowest ratio a model can be calibrated to: dense content, CJK text. */
export const MIN_CALIBRATED_CHARS_PER_TOKEN = 2;
/** Highest ratio a model can be calibrated to: plain English prose. */
export const MAX_CALIBRATED_CHARS_PER_TOKEN = 5;
/** Weight of a new observation in the moving average. */
export const CALIBRATION_EMA_WEIGHT = 0.2;
/** Observations a model needs before its ratio replaces CHARS_PER_TOKEN. */
export const MIN_CALIBRATION_SAMPLES = 3;
/**
 * Requests reported below this many input tokens are not observed: the
 * provider's fixed framing per request is a large share of a small one.
 */
export const MIN_CALIBRATION_INPUT_TOKENS = 1_000;
/** Models kept; the least recently observed are dropped past this. */
const MAX_CALIBRATED_MODELS = 200;
/**
 * An observed ratio outside this range is not a full count of the request
 * (a provider reporting only uncached input, a truncated request) and is
 * ignored rather than clamped into the average.
 */
const MIN_PLAUSIBLE_RATIO = 1;
const MAX_PLAUSIBLE_RATIO = 10;

export interface TokenCalibrationEntry {
	/** Moving average of characters per reported input token, clamped. */
	charsPerToken: number;
	samples: number;
	/** Epoch ms of the latest observation. */
	updatedAt: number;
}

export interface TokenCalibrationSnapshot {
	version: 1;
	models: Record<string, TokenCalibrationEntry>;
}

function clampRatio(value: number): number {
	return Math.min(
		MAX_CALIBRATED_CHARS_PER_TOKEN,
		Math.max(MIN_CALIBRATED_CHARS_PER_TOKEN, value),
	);
}

function isEntry(value: unknown): value is TokenCalibrationEntry {
	if (!value || typeof value !== "object") {
		return false;
	}
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.charsPerToken === "number" &&
		Number.isFinite(entry.charsPerToken) &&
		typeof entry.samples === "number" &&
		Number.isFinite(entry.samples) &&
		entry.samples > 0 &&
		typeof entry.updatedAt === "number" &&
		Number.isFinite(entry.updatedAt)
	);
}

export class TokenCalibration {
	private readonly models = new Map<string, TokenCalibrationEntry>();
	private readonly listeners = new Set<() => void>();

	/**
	 * Fold one call into the model's ratio. `textChars` is the request's
	 * estimated text characters (measureRequestForTokenEstimate) and
	 * `textTokens` the reported input tokens less the fixed image estimate.
	 * Returns whether the observation was kept.
	 */
	observe(
		modelId: string | undefined,
		textChars: number,
		textTokens: number,
		now: number = Date.now(),
	): boolean {
		const key = modelId?.trim();
		if (
			!key ||
			!Number.isFinite(textChars) ||
			!Number.isFinite(textTokens) ||
			textTokens < MIN_CALIBRATION_INPUT_TOKENS
		) {
			return false;
		}
		const observed = textChars / textTokens;
		if (observed < MIN_PLAUSIBLE_RATIO || observed > MAX_PLAUSIBLE_RATIO) {
			return false;
		}
		const sample = clampRatio(observed);
		const previous = this.models.get(key);
		const charsPerToken = previous
			? clampRatio(
					previous.charsPerToken * (1 - CALIBRATION_EMA_WEIGHT) +
						sample * CALIBRATION_EMA_WEIGHT,
				)
			: sample;
		this.models.delete(key);
		this.models.set(key, {
			charsPerToken,
			samples: (previous?.samples ?? 0) + 1,
			updatedAt: now,
		});
		this.evict();
		this.notify();
		return true;
	}

	/**
	 * The model's calibrated ratio, or CHARS_PER_TOKEN for a model without
	 * enough observations.
	 */
	charsPerToken(modelId: string | undefined): number {
		const key = modelId?.trim();
		const entry = key ? this.models.get(key) : undefined;
		if (!entry || entry.samples < MIN_CALIBRATION_SAMPLES) {
			return CHARS_PER_TOKEN;
		}
		return entry.charsPerToken;
	}

	/** The first of `modelIds` with a calibrated ratio, else CHARS_PER_TOKEN. */
	charsPerTokenFor(modelIds: ReadonlyArray<string | undefined>): number {
		for (const modelId of modelIds) {
			const key = modelId?.trim();
			const entry = key ? this.models.get(key) : undefined;
			if (entry && entry.samples >= MIN_CALIBRATION_SAMPLES) {
				return entry.charsPerToken;
			}
		}
		return CHARS_PER_TOKEN;
	}

	snapshot(): TokenCalibrationSnapshot {
		return { version: 1, models: Object.fromEntries(this.models) };
	}

	/**
	 * Merge a saved snapshot: an entry replaces the one held for its model
	 * only when it is newer. Malformed entries are skipped, ratios clamped.
	 * Returns whether anything changed.
	 */
	load(snapshot: unknown): boolean {
		if (!snapshot || typeof snapshot !== "object") {
			return false;
		}
		const models = (snapshot as { models?: unknown }).models;
		if (!models || typeof models !== "object") {
			return false;
		}
		let changed = false;
		for (const [modelId, value] of Object.entries(models)) {
			if (!modelId.trim() || !isEntry(value)) {
				continue;
			}
			const held = this.models.get(modelId);
			if (held && held.updatedAt >= value.updatedAt) {
				continue;
			}
			this.models.set(modelId, {
				charsPerToken: clampRatio(value.charsPerToken),
				samples: Math.floor(value.samples),
				updatedAt: value.updatedAt,
			});
			changed = true;
		}
		if (changed) {
			this.sortByRecency();
			this.evict();
		}
		return changed;
	}

	/** Called after every kept observation. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	clear(): void {
		this.models.clear();
	}

	private sortByRecency(): void {
		const sorted = [...this.models.entries()].sort(
			(left, right) => left[1].updatedAt - right[1].updatedAt,
		);
		this.models.clear();
		for (const [modelId, entry] of sorted) {
			this.models.set(modelId, entry);
		}
	}

	private evict(): void {
		// Insertion order is recency order: observe() re-inserts.
		while (this.models.size > MAX_CALIBRATED_MODELS) {
			const oldest = this.models.keys().next().value;
			if (oldest === undefined) {
				return;
			}
			this.models.delete(oldest);
		}
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A failing listener (a save) must not fail the model call.
			}
		}
	}
}

/** The process-wide calibration every estimate in the engine reads. */
export const tokenCalibration = new TokenCalibration();

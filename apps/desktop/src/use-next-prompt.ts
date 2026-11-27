import type { NextPromptResult } from "@plinycode/shared";
import { useCallback, useEffect, useRef, useState } from "react";

/** Keeps generated choices separate from the draft, and invalidates late replies after user interaction. */
export function useNextPrompt(
	key: string | undefined,
	blocked: boolean,
	request: (force: boolean) => Promise<NextPromptResult>,
) {
	const [view, setView] = useState<{
		key: string;
		status: NextPromptResult["status"] | "pending";
		prompts: string[];
		index: number;
	}>();
	const dismissed = useRef(new Set<string>());
	const attempted = useRef(new Set<string>());
	const current = useRef({ key, blocked, revision: 0 });
	const pending = useRef<number>();
	if (current.current.key !== key || current.current.blocked !== blocked) {
		if (
			current.current.key &&
			(current.current.key !== key ||
				attempted.current.has(current.current.key))
		)
			dismissed.current.add(current.current.key);
		current.current = { key, blocked, revision: current.current.revision + 1 };
		pending.current = undefined;
	}
	const generate = useCallback(
		async (force: boolean) => {
			if (!key || blocked || pending.current !== undefined) return;
			if (!force && dismissed.current.has(key)) return;
			dismissed.current.delete(key);
			attempted.current.add(key);
			const revision = ++current.current.revision;
			pending.current = revision;
			setView({ key, status: "pending", prompts: [], index: 0 });
			try {
				const result = await request(force);
				if (
					current.current.revision === revision &&
					current.current.key === key &&
					!current.current.blocked &&
					!dismissed.current.has(key)
				)
					setView({ key, ...result, index: 0 });
			} catch {
				if (current.current.revision === revision)
					setView({ key, status: "error", prompts: [], index: 0 });
			} finally {
				if (pending.current === revision) pending.current = undefined;
			}
		},
		[key, blocked, request],
	);
	useEffect(() => {
		void generate(false);
		return () => {
			current.current.revision++;
			pending.current = undefined;
		};
	}, [generate]);
	const visible =
		key && !blocked && !dismissed.current.has(key) && view?.key === key
			? view
			: undefined;
	const text = visible?.prompts[visible.index] ?? "";
	return {
		text,
		count: visible?.prompts.length ?? 0,
		index: visible?.index ?? 0,
		pending: visible?.status === "pending",
		canGenerate: !!key && !blocked,
		feedback:
			visible?.status === "pending"
				? "Generating…"
				: visible?.status === "error"
					? "Couldn’t generate—retry."
					: visible?.status === "empty"
						? "No useful follow-up found."
						: "",
		generate: () => generate(true),
		cycle: (direction: number) => {
			if (text)
				setView((value) =>
					value && value.key === key
						? {
								...value,
								index:
									(value.index + direction + value.prompts.length) %
									value.prompts.length,
							}
						: value,
				);
		},
		dismiss: () => {
			if (key) dismissed.current.add(key);
			current.current.revision++;
			pending.current = undefined;
			setView(undefined);
		},
	};
}

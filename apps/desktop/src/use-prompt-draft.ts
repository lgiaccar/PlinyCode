import { type SetStateAction, useEffect, useRef, useState } from "react";
import { DraftBook } from "./drafts";

/** Revision checks also cover edit-away/edit-back, attachments, sending and chat changes. */
export function usePromptDraft(context: string | undefined) {
	const book = useRef(new DraftBook());
	const [, update] = useState(0);
	const prompt = book.current.get(context).text;
	const [improving, setImproving] = useState(false);
	const [error, setError] = useState("");
	const [original, setOriginal] = useState<string>();
	const epoch = useRef(0);
	const activeContext = useRef(context);
	if (activeContext.current !== context) {
		activeContext.current = context;
		epoch.current++;
	}
	function invalidate() {
		if (context === activeContext.current) {
			epoch.current++;
			setOriginal(undefined);
			setError("");
		}
	}
	function setPrompt(value: SetStateAction<string>) {
		invalidate();
		book.current.set(context, value);
		update((value) => value + 1);
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: A chat change invalidates undo and feedback even when the draft text is identical.
	useEffect(() => {
		setOriginal(undefined);
		setError("");
	}, [context]);
	useEffect(
		() => () => {
			epoch.current++;
		},
		[],
	);
	async function improve() {
		if (improving || !book.current.get(context).text.trim()) return;
		const before = { ...book.current.get(context), epoch: epoch.current };
		setImproving(true);
		setError("");
		try {
			const result = await window.plinycode.invoke({
				type: "improvePrompt",
				prompt: before.text,
			});
			if (before.epoch !== epoch.current) return;
			if (result.improvedPrompt?.text !== undefined) {
				setPrompt(result.improvedPrompt.text);
				setOriginal(before.text);
			} else
				setError(
					result.improvedPrompt?.error ??
						"Could not improve the prompt. Your draft was kept.",
				);
		} catch {
			if (before.epoch === epoch.current)
				setError("Could not improve the prompt. Your draft was kept.");
		} finally {
			setImproving(false);
		}
	}
	return {
		prompt,
		setPrompt,
		improve,
		improving,
		error,
		invalidate,
		capture: () => book.current.get(context),
		clearIfUnchanged: (revision: number) => {
			if (book.current.clearIfUnchanged(context, revision)) {
				invalidate();
				update((value) => value + 1);
			}
		},
		canUndo: original !== undefined,
		undo: () => {
			if (original !== undefined) setPrompt(original);
		},
	};
}

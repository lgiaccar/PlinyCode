import { type SetStateAction, useEffect, useRef, useState } from "react";

/** Revision checks also cover edit-away/edit-back, attachments, sending and chat changes. */
export function usePromptDraft(context: string | undefined) {
	const [prompt, update] = useState("");
	const [improving, setImproving] = useState(false);
	const [error, setError] = useState("");
	const [original, setOriginal] = useState<string>();
	const current = useRef({ text: "", revision: 0 });
	const activeContext = useRef(context);
	if (activeContext.current !== context) {
		activeContext.current = context;
		current.current.revision++;
	}
	function invalidate() {
		current.current.revision++;
		setOriginal(undefined);
		setError("");
	}
	function setPrompt(value: SetStateAction<string>) {
		invalidate();
		const text =
			typeof value === "function" ? value(current.current.text) : value;
		current.current.text = text;
		update(text);
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: A chat change invalidates undo and feedback even when the draft text is identical.
	useEffect(() => {
		setOriginal(undefined);
		setError("");
	}, [context]);
	useEffect(
		() => () => {
			current.current.revision++;
		},
		[],
	);
	async function improve() {
		if (improving || !current.current.text.trim()) return;
		const before = { ...current.current };
		setImproving(true);
		setError("");
		try {
			const result = await window.plinycode.invoke({
				type: "improvePrompt",
				prompt: before.text,
			});
			if (before.revision !== current.current.revision) return;
			if (result.improvedPrompt?.text !== undefined) {
				setPrompt(result.improvedPrompt.text);
				setOriginal(before.text);
			} else
				setError(
					result.improvedPrompt?.error ??
						"Could not improve the prompt. Your draft was kept.",
				);
		} catch {
			if (before.revision === current.current.revision)
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
		canUndo: original !== undefined,
		undo: () => {
			if (original !== undefined) setPrompt(original);
		},
	};
}

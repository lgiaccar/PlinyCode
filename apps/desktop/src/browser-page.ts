import type { BrowserAction } from "./browser-contracts";

/** Serialized into an isolated world: keep this function self-contained. */
export function interactWithPage(action: BrowserAction, offset: number) {
	const scope = globalThis as typeof globalThis & {
		plinyElements?: Map<number, HTMLElement>;
	};
	try {
		const visible = (element: HTMLElement) =>
			!!element.getClientRects().length &&
			getComputedStyle(element).visibility === "visible" &&
			!element.closest("[inert],[aria-hidden=true]");
		if (action.operation === "snapshot" || action.operation === "read") {
			const elements = Array.from(
				document.querySelectorAll<HTMLElement>(
					"a,button,input,textarea,select,[role=button],[contenteditable=true]",
				),
			)
				.filter(visible)
				.slice(0, 500);
			scope.plinyElements = new Map(
				elements.map((element, i) => [offset + i + 1, element]),
			);
			return {
				title: document.title.slice(0, 500),
				url: location.href,
				text: (document.body?.innerText ?? "").slice(0, 40_000),
				elements: elements.map((element, i) => ({
					ref: offset + i + 1,
					tag: element.tagName,
					label: (
						element.getAttribute("aria-label") ||
						(element as HTMLInputElement).labels?.[0]?.textContent ||
						element.getAttribute("placeholder") ||
						element.textContent ||
						""
					).slice(0, 250),
					type: element.getAttribute("type"),
				})),
			};
		}
		const element = scope.plinyElements?.get(action.ref ?? -1);
		if (!element?.isConnected || !visible(element))
			throw new Error(
				"Take a fresh read or snapshot and use a visible element reference.",
			);
		if (element.matches(":disabled,[aria-disabled=true]"))
			throw new Error("The referenced control is disabled.");
		if (action.operation === "click") {
			element.click();
			return {
				message:
					"Clicked. Read the page to inspect the result before another action.",
			};
		}
		if (action.operation !== "fill" || typeof action.text !== "string")
			throw new Error("fill requires text.");
		if (
			element instanceof HTMLInputElement &&
			["file", "password"].includes(element.type)
		)
			throw new Error("Enter passwords and choose files manually.");
		if (
			(element instanceof HTMLInputElement ||
				element instanceof HTMLTextAreaElement) &&
			element.readOnly
		)
			throw new Error("The referenced control is read-only.");
		const prototype =
			element instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: element instanceof HTMLSelectElement
					? HTMLSelectElement.prototype
					: element instanceof HTMLInputElement
						? HTMLInputElement.prototype
						: undefined;
		if (prototype) {
			const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
			if (!setter) throw new Error("The control cannot be filled.");
			setter.call(element, action.text);
		} else if (element.isContentEditable) element.textContent = action.text;
		else throw new Error("The referenced element is not editable.");
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
		return { message: "Filled. Read the page to verify the result." };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

import type { SetStateAction } from "react";

/** Immutable revisions let delayed IPC responses change only their originating draft. */
export class DraftBook {
	private drafts = new Map<
		string | undefined,
		{ text: string; revision: number }
	>();
	get(context: string | undefined) {
		return this.drafts.get(context) ?? { text: "", revision: 0 };
	}
	set(context: string | undefined, value: SetStateAction<string>) {
		const before = this.get(context);
		this.drafts.set(context, {
			text: typeof value === "function" ? value(before.text) : value,
			revision: before.revision + 1,
		});
	}
	clearIfUnchanged(context: string | undefined, revision: number) {
		if (this.get(context).revision !== revision) return false;
		this.set(context, "");
		return true;
	}
}

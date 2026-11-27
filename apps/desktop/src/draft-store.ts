import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const savedDraftSchema = z.object({
	text: z.string().max(200_000),
	revision: z.number().int().nonnegative(),
});
export type SavedDraft = z.infer<typeof savedDraftSchema>;

/** Separate from transcripts: drafts never enter engine context until submitted. */
export class DraftStore {
	readonly drafts: Record<string, SavedDraft>;
	constructor(private readonly file: string) {
		this.drafts = existsSync(file)
			? z
					.record(z.string().uuid(), savedDraftSchema)
					.parse(JSON.parse(readFileSync(file, "utf8")))
			: {};
	}
	remove(ids: string[]) {
		const next = { ...this.drafts };
		for (const id of ids) delete next[id];
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(`${this.file}.tmp`, JSON.stringify(next), {
			mode: 0o600,
			flush: true,
		});
		renameSync(`${this.file}.tmp`, this.file);
		for (const id of ids) delete this.drafts[id];
	}
	save(id: string, draft: SavedDraft) {
		if (draft.revision <= (this.drafts[id]?.revision ?? -1)) return;
		const next = { ...this.drafts, [id]: draft };
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(`${this.file}.tmp`, JSON.stringify(next), {
			mode: 0o600,
			flush: true,
		});
		renameSync(`${this.file}.tmp`, this.file);
		this.drafts[id] = draft;
	}
}

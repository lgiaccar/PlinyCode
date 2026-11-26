import { expect, test } from "bun:test";
import { DraftBook } from "../src/drafts";

test("chat drafts are independent and a delayed send cannot clear a newer edit", () => {
	const drafts = new DraftBook();
	drafts.set("first", "original");
	const sent = drafts.get("first");
	expect(drafts.get("second").text).toBe("");
	drafts.set("second", "other chat");
	drafts.set("first", "new edit");
	expect(drafts.clearIfUnchanged("first", sent.revision)).toBe(false);
	expect(drafts.get("first").text).toBe("new edit");
	expect(drafts.get("second").text).toBe("other chat");
	expect(drafts.clearIfUnchanged("first", drafts.get("first").revision)).toBe(
		true,
	);
	expect(drafts.get("second").text).toBe("other chat");
});

test("editing away and back invalidates a pending send; delayed attachments append to the latest draft", () => {
	const drafts = new DraftBook();
	drafts.set("first", "same");
	const sent = drafts.get("first");
	drafts.set("first", "different");
	drafts.set("first", "same");
	expect(drafts.clearIfUnchanged("first", sent.revision)).toBe(false);
	drafts.set("first", (text) => `${text}\nattachment`);
	expect(drafts.get("first").text).toBe("same\nattachment");
});

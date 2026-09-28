import type { TextContent, ToolResultContent } from "@plinycode/shared";
import { isStructuredToolResultEntry } from "./content-entries";
import {
	extractLocatorFromResultEntry,
	type ReadLocator,
	toReadLocatorKey,
} from "./read-locators";

const OUTDATED_FILE_CONTENT = "[outdated - see the latest file content]";

export function replaceOutdatedReadContent(
	content: ToolResultContent["content"],
	outdated: ReadLocator[],
): ToolResultContent["content"] {
	const outdatedKeys = new Set(outdated.map((l) => toReadLocatorKey(l)));
	const outdatedPaths = new Set(outdated.map((l) => l.path));

	if (typeof content === "string") {
		return (
			replaceOutdatedInString(content, outdatedKeys) ?? OUTDATED_FILE_CONTENT
		);
	}

	// Image entries are paired with text result markers, so rewrite them positionally.
	let pendingImageReplacements = 0;
	for (const entry of content) {
		if (entry.type === "text") {
			pendingImageReplacements += countOutdatedImageEntries(
				entry.text,
				outdatedKeys,
			);
		}
	}

	return content.map((entry) => {
		if (entry.type === "file") {
			if (!outdatedPaths.has(entry.path)) {
				return entry;
			}
			return { ...entry, content: OUTDATED_FILE_CONTENT };
		}
		if (entry.type === "image") {
			if (pendingImageReplacements === 0) {
				return entry;
			}
			pendingImageReplacements -= 1;
			return {
				type: "text",
				text: OUTDATED_FILE_CONTENT,
			} satisfies TextContent;
		}
		if (isStructuredToolResultEntry(entry)) {
			return replaceOutdatedReadEntry(entry, outdatedKeys) as typeof entry;
		}
		if (entry.type !== "text") {
			return entry;
		}
		const replaced = replaceOutdatedInString(entry.text, outdatedKeys);
		if (replaced === null) {
			return { ...entry, text: OUTDATED_FILE_CONTENT };
		}
		return replaced === entry.text ? entry : { ...entry, text: replaced };
	});
}

export function countOutdatedImageEntries(
	text: string,
	outdatedKeys: Set<string>,
): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return 0;
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	let count = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const locator = extractLocatorFromResultEntry(record);
		if (!locator) {
			continue;
		}
		if (!outdatedKeys.has(toReadLocatorKey(locator))) {
			continue;
		}
		if (
			record.result === "Successfully read image" ||
			record.content === "Successfully read image"
		) {
			count += 1;
		}
	}
	return count;
}

function replaceOutdatedInString(
	text: string,
	outdatedKeys: Set<string>,
): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const replaced = Array.isArray(parsed)
		? parsed.map((entry) => replaceOutdatedReadEntry(entry, outdatedKeys))
		: replaceOutdatedReadEntry(parsed, outdatedKeys);
	return JSON.stringify(replaced);
}

function replaceOutdatedReadEntry(
	entry: unknown,
	outdatedKeys: Set<string>,
): unknown {
	if (!entry || typeof entry !== "object") {
		return entry;
	}
	const locator = extractLocatorFromResultEntry(entry);
	if (!locator || !outdatedKeys.has(toReadLocatorKey(locator))) {
		return entry;
	}
	const record = { ...(entry as Record<string, unknown>) };
	if (typeof record.result === "string") {
		record.result = OUTDATED_FILE_CONTENT;
	} else if (typeof record.content === "string") {
		record.content = OUTDATED_FILE_CONTENT;
	} else {
		record.result = OUTDATED_FILE_CONTENT;
	}
	return record;
}

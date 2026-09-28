import type { ToolResultContent } from "@plinycode/shared";
import { isStructuredToolResultEntry } from "./content-entries";

const READ_TOOL_NAMES = new Set(["read", "read_files"]);

export interface ReadLocator {
	path: string;
	startLine: number | null;
	endLine: number | null;
}

export function extractLocatorsFromReadToolInput(
	input: unknown,
): ReadLocator[] {
	if (!input || typeof input !== "object") {
		return [];
	}

	const record = input as Record<string, unknown>;
	const locators: ReadLocator[] = [];
	const direct = extractLocatorFromReadRequest(record);
	if (direct) {
		locators.push(direct);
	}

	if (Array.isArray(record.files)) {
		for (const value of record.files) {
			const locator = extractLocatorFromReadRequest(value);
			if (locator) {
				locators.push(locator);
			}
		}
	}

	if (Array.isArray(record.file_paths)) {
		for (const value of record.file_paths) {
			if (typeof value === "string" && value.length > 0) {
				locators.push({ path: value, startLine: null, endLine: null });
			}
		}
	}

	return dedupeReadLocators(locators);
}

export function extractReadLocatorsFromToolResultContent(
	content: ToolResultContent["content"],
): ReadLocator[] {
	if (typeof content === "string") {
		return tryParseReadLocators(content);
	}
	const locators: ReadLocator[] = [];
	for (const entry of content) {
		if (entry.type === "text") {
			locators.push(...tryParseReadLocators(entry.text));
			continue;
		}
		if (isStructuredToolResultEntry(entry)) {
			const locator = extractLocatorFromResultEntry(entry);
			if (locator) {
				locators.push(locator);
			}
		}
	}
	return dedupeReadLocators(locators);
}

function tryParseReadLocators(text: string): ReadLocator[] {
	try {
		return extractLocatorsFromParsedReadResult(JSON.parse(text));
	} catch {
		return [];
	}
}

function extractLocatorsFromParsedReadResult(value: unknown): ReadLocator[] {
	if (Array.isArray(value)) {
		const locators: ReadLocator[] = [];
		for (const item of value) {
			const locator = extractLocatorFromResultEntry(item);
			if (locator) {
				locators.push(locator);
			}
		}
		return dedupeReadLocators(locators);
	}
	const locator = extractLocatorFromResultEntry(value);
	return locator ? [locator] : [];
}

function extractLocatorFromReadRequest(
	value: unknown,
): ReadLocator | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const path = extractPath(record);
	if (!path) {
		return undefined;
	}
	return {
		path,
		startLine: extractLineNumber(record.start_line),
		endLine: extractLineNumber(record.end_line),
	};
}

export function extractLocatorFromResultEntry(
	value: unknown,
): ReadLocator | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const path = extractPath(record);
	if (path) {
		return {
			path,
			startLine: extractLineNumber(record.start_line),
			endLine: extractLineNumber(record.end_line),
		};
	}
	if (typeof record.query === "string" && record.query.length > 0) {
		return parseReadQuery(record.query);
	}
	return undefined;
}

function extractPath(record: Record<string, unknown>): string | undefined {
	const candidates = [record.path, record.file_path, record.filePath];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

function extractLineNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseReadQuery(query: string): ReadLocator {
	const match = /^(.*):(\d+)-(EOF|\d+)$/.exec(query);
	if (!match) {
		return { path: query, startLine: null, endLine: null };
	}
	return {
		path: match[1],
		startLine: Number(match[2]),
		endLine: match[3] === "EOF" ? null : Number(match[3]),
	};
}

function dedupeReadLocators(locators: ReadLocator[]): ReadLocator[] {
	const unique = new Map<string, ReadLocator>();
	for (const locator of locators) {
		unique.set(toReadLocatorKey(locator), locator);
	}
	return Array.from(unique.values());
}

export function toReadLocatorKey(locator: ReadLocator): string {
	if (isFullFileRead(locator)) {
		return locator.path;
	}
	return `${locator.path}:${locator.startLine ?? 1}-${locator.endLine ?? "EOF"}`;
}

export function isFullFileRead(locator: ReadLocator): boolean {
	return locator.startLine == null && locator.endLine == null;
}

export function isReadTool(toolName: string | undefined): boolean {
	return !!toolName && READ_TOOL_NAMES.has(toolName);
}

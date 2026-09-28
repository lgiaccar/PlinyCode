import type { ImageContent } from "@plinycode/shared";

/**
 * True for tool_result content entries that are not the typed text/image/file
 * blocks — i.e. structured tool outputs such as `ToolOperationResult[]`
 * entries that the runtime stores directly in the content array.
 */
export function isStructuredToolResultEntry(entry: unknown): boolean {
	if (entry === null || typeof entry !== "object") {
		return false;
	}
	const type = (entry as { type?: unknown }).type;
	return type !== "text" && type !== "image" && type !== "file";
}

export function isImageContentLike(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "image"
	);
}

export function isImageContentWithData(value: unknown): value is ImageContent {
	return (
		value !== null &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "image" &&
		typeof (value as { data?: unknown }).data === "string" &&
		typeof (value as { mediaType?: unknown }).mediaType === "string"
	);
}

export function isBinaryContentLike(value: unknown): boolean {
	return isImageContentWithData(value);
}

import { z } from "zod";

export const embeddedBrowserCommandSchema = z.discriminatedUnion("operation", [
	z.object({ operation: z.literal("status") }),
	z.object({ operation: z.literal("show"), visible: z.boolean() }),
	z.object({
		operation: z.literal("navigate"),
		url: z.string().min(1).max(8000),
	}),
	z.object({ operation: z.literal("back") }),
	z.object({ operation: z.literal("forward") }),
	z.object({ operation: z.literal("reload") }),
	z.object({ operation: z.literal("stop") }),
	z.object({ operation: z.literal("takeover") }),
	z.object({ operation: z.literal("resume") }),
	z.object({
		operation: z.literal("bounds"),
		x: z.number().finite().min(0),
		y: z.number().finite().min(0),
		width: z.number().finite().min(0),
		height: z.number().finite().min(0),
		visible: z.boolean(),
	}),
]);
export type EmbeddedBrowserCommand = z.infer<
	typeof embeddedBrowserCommandSchema
>;
export interface EmbeddedBrowserState {
	visible: boolean;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	manual: boolean;
	owner?: string;
	error?: string;
}

export function browserUrl(value: string): string {
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
	return url.href;
}

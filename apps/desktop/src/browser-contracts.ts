import { z } from "zod";

export const browserActionSchema = z.object({
	operation: z.enum([
		"tabs",
		"snapshot",
		"read",
		"click",
		"fill",
		"navigate",
		"release",
	]),
	tabId: z.number().int().nonnegative().optional(),
	ref: z.number().int().positive().optional(),
	text: z.string().max(100_000).optional(),
	url: z.string().url().max(8000).optional(),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;
export interface BrowserStatus {
	connected: boolean;
	address?: string;
	token?: string;
}

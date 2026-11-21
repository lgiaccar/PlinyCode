import { z } from "zod";

const segment = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine(
		(value) =>
			!/[\\/]/.test(value) &&
			![...value].some((character) => character.charCodeAt(0) < 32) &&
			value !== "." &&
			value !== "..",
		"Enter a repository path segment.",
	);
export const prRepositorySchema = z.object({
	provider: z.enum(["github", "azure"]),
	apiUrl: z
		.string()
		.url()
		.max(2000)
		.refine((value) => {
			const url = new URL(value);
			return (
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				(url.protocol === "https:" ||
					(url.protocol === "http:" &&
						["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
			);
		}, "Use HTTPS without credentials, a query or a fragment."),
	owner: segment,
	repository: segment,
	apiVersion: z.enum(["6.0", "7.0", "7.1"]).default("7.0"),
});
export type PrRepository = z.infer<typeof prRepositorySchema>;
export const prCreateSchema = z.object({
	title: z.string().trim().min(1).max(250),
	body: z.string().max(60_000),
	target: z.string().trim().min(1).max(200),
	draft: z.boolean(),
	commit: z.boolean(),
	retryUncertain: z.boolean().default(false),
});
export type PrCreate = z.infer<typeof prCreateSchema>;
export interface PullRequest {
	status:
		| "publishing"
		| "creating"
		| "open"
		| "closed"
		| "merged"
		| "failed"
		| "uncertain";
	target: string;
	url?: string;
	number?: number;
	error?: string;
}
export interface PrPreview {
	branch: string;
	target: string;
	remote: string;
	changes: string;
	commits: string;
}

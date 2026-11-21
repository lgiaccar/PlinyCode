import { expect, test } from "bun:test";
import { PullRequestProvider } from "../src/pull-requests";

test("real HTTP provider fixtures cover GitHub, Azure collection paths, redirects and cancellation", async () => {
	let leakedRequests = 0,
		mode = "github",
		creates = 0;
	const other = Bun.serve({
		port: 0,
		fetch: () => {
			leakedRequests++;
			return Response.json({});
		},
	});
	const requests: {
		path: string;
		auth: string | null;
		body?: Record<string, unknown>;
	}[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request): Promise<Response> => {
			const url = new URL(request.url);
			if (mode === "redirect") return Response.redirect(other.url);
			const body =
				request.method === "POST"
					? ((await request.json()) as Record<string, unknown>)
					: undefined;
			requests.push({
				path: url.pathname,
				auth: request.headers.get("authorization"),
				body,
			});
			if (body) creates++;
			const item =
				mode === "azure"
					? { pullRequestId: 2, status: "active" }
					: {
							number: 2,
							html_url: `${server.url}owner/repo/pull/2`,
							state: "open",
						};
			return Response.json(
				body || url.pathname.endsWith("/2")
					? item
					: mode === "azure"
						? { value: creates ? [item] : [] }
						: creates
							? [item]
							: [],
			);
		},
	});
	try {
		for (const providerName of ["github", "azure"] as const) {
			mode = providerName;
			creates = 0;
			const provider = new PullRequestProvider(
				{
					provider: providerName,
					apiUrl: `${server.url}${providerName === "azure" ? "tfs/collection" : ""}`,
					owner: "owner",
					repository: "repo",
					apiVersion: "6.0",
				},
				"http-fixture-token",
			);
			expect(await provider.find("feature", "main")).toBeUndefined();
			expect(
				(
					await provider.create("feature", {
						title: "Fixture",
						body: "Report",
						target: "main",
						commit: false,
						draft: true,
						retryUncertain: false,
					})
				).number,
			).toBe(2);
			expect((await provider.find("feature", "main"))?.number).toBe(2);
			expect((await provider.get(2, "main")).status).toBe("open");
		}
		expect(requests[1].auth).toBe("Bearer http-fixture-token");
		expect(requests[5].path).toBe(
			"/tfs/collection/owner/_apis/git/repositories/repo/pullrequests",
		);
		expect(requests[5].body?.sourceRefName).toBe("refs/heads/feature");
		mode = "redirect";
		const provider = new PullRequestProvider(
			{
				provider: "github",
				apiUrl: server.url.href,
				owner: "owner",
				repository: "repo",
				apiVersion: "7.0",
			},
			"http-fixture-token",
		);
		await expect(provider.find("feature", "main")).rejects.toThrow(
			"interrupted or unreachable",
		);
		expect(leakedRequests).toBe(0);
		const controller = new AbortController();
		controller.abort();
		await expect(
			provider.find("feature", "main", controller.signal),
		).rejects.toThrow("interrupted or unreachable");
	} finally {
		server.stop(true);
		other.stop(true);
	}
});

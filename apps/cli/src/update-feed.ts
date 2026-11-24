import { compareVersions, validVersion } from "./update-layout";

declare const PLINYCODE_UPDATE_TEST_FEED: string;
const testFeed =
	typeof PLINYCODE_UPDATE_TEST_FEED === "string"
		? PLINYCODE_UPDATE_TEST_FEED
		: "";
const repository = "https://api.github.com/repos/lgiaccar/PlinyCode/releases";
export interface Release {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string; browser_download_url: string }[];
}
export function assetName(version: string, platform: string): string {
	return `PlinyCode-CLI-${version}-${platform}-x64.${platform === "windows" ? "zip" : "tar.gz"}`;
}
export async function download(
	url: string,
	limit: number,
	timeout = 120000,
): Promise<Buffer> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(timeout),
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "PlinyCode-CLI-updater",
		},
	});
	if (!response.ok)
		throw new Error(
			`Update download failed: HTTP ${response.status}. Retry later; the installed version is unchanged.`,
		);
	if (Number(response.headers.get("content-length")) > limit)
		throw new Error("Update download exceeds size limit.");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty update response.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) throw new Error("Update download exceeds size limit.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks);
}
export function selectRelease(
	releases: Release[],
	target?: string,
): Release | undefined {
	return releases
		.filter(
			(r) =>
				!r.draft &&
				!r.prerelease &&
				r.tag_name.startsWith("cli-v") &&
				validVersion(r.tag_name.slice(5)) &&
				(!target || r.tag_name === `cli-v${target}`),
		)
		.sort((a, b) =>
			compareVersions(b.tag_name.slice(5), a.tag_name.slice(5)),
		)[0];
}
export async function findRelease(target?: string): Promise<Release> {
	if (target && !validVersion(target))
		throw new Error("Use a stable version such as 0.1.2.");
	const base = testFeed || repository;
	if (target) {
		const release = JSON.parse(
			(
				await download(`${base}/tags/cli-v${target}`, 2_000_000, 15000)
			).toString(),
		);
		const selected = selectRelease([release], target);
		if (!selected)
			throw new Error("Requested stable CLI release was not found.");
		return selected;
	}
	const releases: Release[] = [];
	for (let page = 1; page <= 20; page++) {
		const batch = JSON.parse(
			(
				await download(`${base}?per_page=100&page=${page}`, 4_000_000, 15000)
			).toString(),
		);
		if (!Array.isArray(batch)) throw new Error("Invalid release list.");
		releases.push(...batch);
		if (batch.length < 100) {
			const selected = selectRelease(releases);
			if (!selected) throw new Error("No stable CLI release was found.");
			return selected;
		}
	}
	throw new Error(
		"Release listing is too large. Specify update --version explicitly.",
	);
}
export function assetURL(release: Release, name: string): string {
	const matches = release.assets.filter((a) => a.name === name);
	if (matches.length !== 1)
		throw new Error(`Missing or duplicate release asset: ${name}`);
	const url = matches[0].browser_download_url;
	const prefix = `https://github.com/lgiaccar/PlinyCode/releases/download/${release.tag_name}/`;
	const testOrigin = testFeed ? new URL(testFeed).origin : "";
	if (
		url !== `${prefix}${name}` &&
		!(
			testOrigin &&
			new URL(url).origin === testOrigin &&
			new URL(url).protocol === "http:"
		)
	)
		throw new Error("Unexpected update asset URL.");
	return url;
}

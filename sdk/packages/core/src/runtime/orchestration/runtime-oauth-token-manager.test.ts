import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsManager } from "../../services/storage/provider-settings-manager";
import {
	OAuthReauthRequiredError,
	RuntimeOAuthTokenManager,
} from "./runtime-oauth-token-manager";

const { getValidOpenAICodexCredentials } = vi.hoisted(() => ({
	getValidOpenAICodexCredentials: vi.fn(),
}));

vi.mock("../../auth/codex", () => ({
	getValidOpenAICodexCredentials,
}));

describe("RuntimeOAuthTokenManager", () => {
	let testDir: string;
	afterEach(() => rmSync(testDir, { recursive: true, force: true }));
	beforeEach(() => {
		vi.resetAllMocks();
		testDir = mkdtempSync(join(tmpdir(), "oauth-manager-test-"));
	});

	it("refreshes and persists OpenAI Codex OAuth credentials", async () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "access-old",
				refreshToken: "refresh-old",
				expiresAt: Date.now() - 1_000,
				accountId: "acct-old",
			},
		});
		const saveProviderSettings = vi.fn();

		getValidOpenAICodexCredentials.mockResolvedValueOnce({
			access: "access-new",
			refresh: "refresh-new",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
		});

		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings,
				saveProviderSettings,
			} as never,
		});

		const result = await manager.resolveProviderApiKey({
			providerId: "openai-codex",
		});

		expect(result).toMatchObject({
			apiKey: "access-new",
			accountId: "acct-new",
			refreshed: true,
		});
		expect(saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				auth: expect.objectContaining({
					accessToken: "access-new",
					refreshToken: "refresh-new",
					accountId: "acct-new",
					expiresAt: 4_000_000_000_000,
				}),
			}),
			{ setLastUsed: false, tokenSource: "oauth" },
		);
	});

	it("throws re-auth required when refresh returns null", async () => {
		getValidOpenAICodexCredentials.mockResolvedValueOnce(null);
		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings: vi.fn().mockReturnValue({
					provider: "openai-codex",
					auth: {
						accessToken: "access-old",
						refreshToken: "refresh-old",
						expiresAt: Date.now() - 1_000,
					},
				}),
				saveProviderSettings: vi.fn(),
			} as never,
		});

		await expect(
			manager.resolveProviderApiKey({ providerId: "openai-codex" }),
		).rejects.toBeInstanceOf(OAuthReauthRequiredError);
	});

	it("de-duplicates concurrent refresh calls per provider", async () => {
		const refreshBarrier = Promise.resolve().then(() => ({
			access: "access-new",
			refresh: "refresh-new",
			expires: Date.now() + 60_000,
		}));
		getValidOpenAICodexCredentials.mockImplementationOnce(
			async () => refreshBarrier,
		);

		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings: vi.fn().mockReturnValue({
					provider: "openai-codex",
					auth: {
						accessToken: "access-old",
						refreshToken: "refresh-old",
						expiresAt: Date.now() - 1_000,
					},
				}),
				saveProviderSettings: vi.fn(),
			} as never,
		});

		const [first, second] = await Promise.all([
			manager.resolveProviderApiKey({ providerId: "openai-codex" }),
			manager.resolveProviderApiKey({ providerId: "openai-codex" }),
		]);

		expect(first?.apiKey).toBe("access-new");
		expect(second?.apiKey).toBe("access-new");
		expect(getValidOpenAICodexCredentials).toHaveBeenCalledTimes(1);
	});

	it("coordinates independent managers and does not force-refresh a token another manager just rotated", async () => {
		const settings = new ProviderSettingsManager({
			filePath: join(testDir, "providers.json"),
		});
		settings.saveProviderSettings({
			provider: "openai-codex",
			auth: {
				accessToken: "old",
				refreshToken: "single-use",
				expiresAt: 1,
				accountId: "account-a",
			},
		});
		let finish!: () => void;
		getValidOpenAICodexCredentials.mockImplementation(
			async (credentials, { forceRefresh }) => {
				if (!forceRefresh && credentials.access === "new") return credentials;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return {
					access: "new",
					refresh: "rotated",
					expires: Date.now() + 3_600_000,
					accountId: "account-a",
				};
			},
		);
		const first = new RuntimeOAuthTokenManager({
			providerSettingsManager: settings,
		});
		const second = new RuntimeOAuthTokenManager({
			providerSettingsManager: settings,
		});
		const a = first.resolveProviderApiKey({
			providerId: "openai-codex",
			forceRefresh: true,
		});
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		const b = second.resolveProviderApiKey({
			providerId: "openai-codex",
			forceRefresh: true,
		});
		finish();
		expect((await Promise.all([a, b])).map((result) => result?.apiKey)).toEqual(
			["new", "new"],
		);
		expect(getValidOpenAICodexCredentials.mock.calls[1][1]).toEqual({
			forceRefresh: false,
		});
	});

	it("does not restore credentials when the user signs out during refresh", async () => {
		const settings = new ProviderSettingsManager({
			filePath: join(testDir, "providers.json"),
		});
		settings.saveProviderSettings({
			provider: "openai-codex",
			auth: {
				accessToken: "old",
				refreshToken: "single-use",
				expiresAt: 1,
				accountId: "account-a",
			},
		});
		let finish!: () => void;
		getValidOpenAICodexCredentials.mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return {
				access: "new",
				refresh: "rotated",
				expires: Date.now() + 3_600_000,
				accountId: "account-a",
			};
		});
		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: settings,
		});
		const result = manager.resolveProviderApiKey({
			providerId: "openai-codex",
		});
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		settings.saveProviderSettings({ provider: "openai-codex", auth: {} });
		finish();
		expect(await result).toBeNull();
		expect(
			settings.getProviderSettings("openai-codex")?.auth?.accessToken,
		).toBeUndefined();
	});
});

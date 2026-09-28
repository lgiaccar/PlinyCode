import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatProviderOAuthApiKey,
	getPersistedProviderApiKey,
	getProviderAuthHandler,
	getProviderAuthStorageId,
	getProviderOAuthCredentialsFromSettings,
	isOAuthProvider,
	loginAndSaveProviderOAuthCredentials,
	resolveProviderApiKeyFromSettings,
} from "./provider-auth-registry";

const { loginOpenAICodex } = vi.hoisted(() => ({
	loginOpenAICodex: vi.fn(),
}));

vi.mock("./codex", () => ({
	getValidOpenAICodexCredentials: vi.fn(),
	loginOpenAICodex,
}));

describe("provider auth registry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns handlers for managed OAuth providers only", () => {
		expect(getProviderAuthHandler("openai-codex")?.providerId).toBe(
			"openai-codex",
		);
		expect(getProviderAuthHandler("cline")).toBeUndefined();
		expect(getProviderAuthHandler("oca")).toBeUndefined();
		expect(getProviderAuthHandler("openai-codex-cli")).toBeUndefined();
		expect(isOAuthProvider("openai-codex-cli")).toBe(false);
	});

	it("returns storage provider IDs from handlers", () => {
		expect(getProviderAuthStorageId("openai-codex")).toBe("openai-codex");
		expect(getProviderAuthStorageId("openai-codex-cli")).toBeUndefined();
	});

	it("uses the stored access token as the API key", () => {
		expect(formatProviderOAuthApiKey("openai-codex", { access: "abc" })).toBe(
			"abc",
		);
		expect(
			getPersistedProviderApiKey("openai-codex", {
				provider: "openai-codex",
				auth: { accessToken: "abc" },
			}),
		).toBe("abc");
	});

	it("resolves API keys from the handler's storage", () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: { accessToken: "abc" },
		});
		const manager = { getProviderSettings } as never;

		expect(resolveProviderApiKeyFromSettings(manager, "openai-codex")).toBe(
			"abc",
		);
		expect(getProviderSettings).toHaveBeenCalledWith("openai-codex");
	});

	it("login/save stores credentials under handler storageProviderId", async () => {
		loginOpenAICodex.mockResolvedValueOnce({
			access: "new-access",
			refresh: "new-refresh",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
			metadata: { sessionStartedAtMs: 1_700_000_000_001 },
		});
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			apiKey: "manual-key",
		});
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings,
			saveProviderSettings,
		} as never;

		const saved = await loginAndSaveProviderOAuthCredentials(
			manager,
			"openai-codex",
			{
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			},
		);

		expect(getProviderSettings).toHaveBeenCalledWith("openai-codex");
		expect(saved).toMatchObject({
			provider: "openai-codex",
			apiKey: "manual-key",
			auth: {
				accessToken: "new-access",
				refreshToken: "new-refresh",
				accountId: "acct-new",
				expiresAt: 4_000_000_000_000,
				metadata: { sessionStartedAtMs: 1_700_000_000_001 },
			},
		});
		expect(saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "openai-codex" }),
			{ tokenSource: "oauth" },
		);
	});

	it("login/save preserves existing auth metadata when incoming metadata is missing", async () => {
		loginOpenAICodex.mockResolvedValueOnce({
			access: "new-access",
			refresh: "new-refresh",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
		});
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "old-access",
				refreshToken: "old-refresh",
				accountId: "acct-old",
				metadata: {
					provider: "openai",
					sessionStartedAtMs: 1_700_000_000_003,
				},
			},
		});
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings,
			saveProviderSettings,
		} as never;

		const saved = await loginAndSaveProviderOAuthCredentials(
			manager,
			"openai-codex",
			{
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			},
		);

		expect(saved).toMatchObject({
			auth: {
				accessToken: "new-access",
				metadata: {
					provider: "openai",
					sessionStartedAtMs: 1_700_000_000_003,
				},
			},
		});
	});

	it("login/save does not let undefined incoming metadata erase existing metadata", async () => {
		loginOpenAICodex.mockResolvedValueOnce({
			access: "new-access",
			refresh: "new-refresh",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
			metadata: { provider: undefined, tokenType: "Bearer" },
		});
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "old-access",
				refreshToken: "old-refresh",
				accountId: "acct-old",
				metadata: {
					provider: "openai",
					sessionStartedAtMs: 1_700_000_000_004,
				},
			},
		});
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings,
			saveProviderSettings,
		} as never;

		const saved = await loginAndSaveProviderOAuthCredentials(
			manager,
			"openai-codex",
			{
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			},
		);

		expect(saved).toMatchObject({
			auth: {
				accessToken: "new-access",
				metadata: {
					provider: "openai",
					sessionStartedAtMs: 1_700_000_000_004,
					tokenType: "Bearer",
				},
			},
		});
	});

	it("reads persisted auth metadata back into OAuth credentials", () => {
		const credentials = getProviderOAuthCredentialsFromSettings(
			"openai-codex",
			{
				provider: "openai-codex",
				auth: {
					accessToken: "stored-access",
					refreshToken: "stored-refresh",
					expiresAt: 4_000_000_000_000,
					accountId: "acct-stored",
					metadata: { sessionStartedAtMs: 1_700_000_000_002 },
				},
			},
		);

		expect(credentials).toMatchObject({
			access: "stored-access",
			refresh: "stored-refresh",
			accountId: "acct-stored",
			metadata: { sessionStartedAtMs: 1_700_000_000_002 },
		});
	});
});

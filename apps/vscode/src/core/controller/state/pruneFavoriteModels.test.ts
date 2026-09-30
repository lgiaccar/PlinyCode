import type { ModelInfo } from "@shared/api"
import { describe, expect, it } from "vitest"
import type { ProviderModelsResult } from "@/sdk/model-catalog/contracts"
import { pruneFavoriteModels } from "./pruneFavoriteModels"

function stateWith(favorites: string[]) {
	const state = {
		favorites,
		reloadGlobalStateKey: (_key: "favoritedModelIds") => state.favorites,
		setGlobalState: (_key: "favoritedModelIds", value: string[]) => {
			state.favorites = value
		},
	}
	return state
}

function catalog(ids: string[], overrides: Partial<Record<string, unknown>> = {}): ProviderModelsResult {
	return {
		ok: true,
		providerId: "pliny",
		configFingerprint: "fp",
		models: new Map(ids.map((id) => [id, {} as ModelInfo])),
		defaultModelId: ids[0] ?? "",
		source: "sdk-dynamic",
		fetchedAt: 0,
		...overrides,
	} as unknown as ProviderModelsResult
}

describe("pruneFavoriteModels", () => {
	it("drops only favorites whose model is gone from the catalog", () => {
		const state = stateWith(["a", "gone", "b"])
		expect(pruneFavoriteModels(state, catalog(["a", "b", "c"]))).toBe(true)
		expect(state.favorites).toEqual(["a", "b"])
	})

	it("leaves favorites alone when every model is still there", () => {
		const state = stateWith(["a", "b"])
		expect(pruneFavoriteModels(state, catalog(["a", "b"]))).toBe(false)
		expect(state.favorites).toEqual(["a", "b"])
	})

	it("carries a router id from before the rename over to its current id", () => {
		const state = stateWith(["pliny/free-auto"])
		expect(pruneFavoriteModels(state, catalog(["pliny/auto-free"]))).toBe(true)
		expect(state.favorites).toEqual(["pliny/auto-free"])
	})

	it("never prunes on a failed, empty or offline catalog", () => {
		const state = stateWith(["a"])
		expect(pruneFavoriteModels(state, catalog([]))).toBe(false)
		expect(pruneFavoriteModels(state, catalog(["b"], { source: "sdk-bundled" }))).toBe(false)
		expect(
			pruneFavoriteModels(state, {
				ok: false,
				providerId: "pliny",
				configFingerprint: "fp",
				error: { kind: "network", message: "offline" },
			} as unknown as ProviderModelsResult),
		).toBe(false)
		expect(state.favorites).toEqual(["a"])
	})
})

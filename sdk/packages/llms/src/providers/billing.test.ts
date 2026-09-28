import { describe, expect, it } from "vitest";
import {
	resolveProviderUsageCostDisplay,
	shouldShowProviderUsageCost,
} from "./billing";
import { getProviderCollectionSync } from "./model-registry";

describe("provider usage cost display", () => {
	it("shows usage cost by default for usage-billed providers", () => {
		expect(resolveProviderUsageCostDisplay("openrouter")).toBe("show");
		expect(resolveProviderUsageCostDisplay("anthropic")).toBe("show");
		expect(resolveProviderUsageCostDisplay("deepseek")).toBe("show");
		expect(shouldShowProviderUsageCost("anthropic")).toBe(true);
	});

	it("shows usage cost for Pliny (hosted models are priced, self-hosted are explicit $0)", () => {
		expect(resolveProviderUsageCostDisplay("pliny")).toBe("show");
		expect(shouldShowProviderUsageCost("pliny")).toBe(true);
	});

	it("stores the display policy on provider metadata", () => {
		expect(getProviderCollectionSync("pliny")?.provider.metadata).toMatchObject(
			{ usageCostDisplay: "show" },
		);
	});
});

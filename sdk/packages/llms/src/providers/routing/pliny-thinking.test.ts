import { describe, expect, it } from "vitest";
import { plinyThinkingFields } from "./pliny-thinking";

describe("plinyThinkingFields", () => {
	it("sends nothing for a model that was never measured", () => {
		expect(plinyThinkingFields(false, undefined)).toBeUndefined();
		expect(plinyThinkingFields(true, undefined)).toBeUndefined();
	});

	it("sends nothing when the request leaves reasoning unset", () => {
		expect(
			plinyThinkingFields(undefined, {
				defaultOn: true,
				off: "template-kwargs",
			}),
		).toBeUndefined();
	});

	it("sends nothing when the model already behaves as asked", () => {
		expect(
			plinyThinkingFields(true, { defaultOn: true, off: "template-kwargs" }),
		).toBeUndefined();
		expect(
			plinyThinkingFields(false, { defaultOn: false, on: "template-kwargs" }),
		).toBeUndefined();
	});

	it("uses the measured off-switch", () => {
		expect(
			plinyThinkingFields(false, { defaultOn: true, off: "template-kwargs" }),
		).toEqual({ chat_template_kwargs: { enable_thinking: false } });
		expect(
			plinyThinkingFields(false, {
				defaultOn: true,
				off: "reasoning-effort-none",
			}),
		).toEqual({ reasoning_effort: "none" });
		expect(
			plinyThinkingFields(false, { defaultOn: true, off: "reasoning-exclude" }),
		).toEqual({ reasoning: { exclude: true } });
	});

	it("sends nothing for an always-on model rather than guessing a switch", () => {
		expect(plinyThinkingFields(false, { defaultOn: true })).toBeUndefined();
	});

	it("leaves turning reasoning on to the portable reasoning_effort field", () => {
		expect(
			plinyThinkingFields(true, { defaultOn: false, on: "reasoning-effort" }),
		).toBeUndefined();
		expect(
			plinyThinkingFields(true, { defaultOn: false, on: "template-kwargs" }),
		).toBeUndefined();
	});
});

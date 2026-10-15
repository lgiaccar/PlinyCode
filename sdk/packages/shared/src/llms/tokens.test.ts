import { describe, expect, it } from "vitest";
import {
	CHARS_PER_TOKEN,
	estimateRequestInputTokens,
	estimateValueTokens,
	IMAGE_TOKEN_ESTIMATE,
	isBinaryPayload,
	serializeForTokenEstimate,
} from "./tokens";

const base64Image = "iVBORw0KGgoAAAANSUhEUgAAA".repeat(40_000); // ~1 MB

describe("token estimate and images", () => {
	it("counts an image at a fixed estimate, not as its base64 text", () => {
		const message = {
			role: "user",
			content: [
				{ type: "text", text: "what is in this screenshot?" },
				{ type: "image", data: base64Image, mediaType: "image/png" },
			],
		};
		const tokens = estimateValueTokens(message);
		expect(tokens).toBeGreaterThan(IMAGE_TOKEN_ESTIMATE);
		expect(tokens).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 200);
		// Counted as text it would be some 350k tokens.
		expect(base64Image.length / CHARS_PER_TOKEN).toBeGreaterThan(300_000);
	});

	it("recognises data URLs and base64 blobs, and leaves text and code alone", () => {
		expect(isBinaryPayload(`data:image/png;base64,${"A".repeat(3000)}`)).toBe(
			true,
		);
		expect(isBinaryPayload(base64Image)).toBe(true);
		expect(isBinaryPayload("A".repeat(100))).toBe(false);
		// A repeated character, a hex digest or an identifier is text: base64 of
		// real bytes mixes cases, digits and symbols.
		expect(isBinaryPayload("x".repeat(5000))).toBe(false);
		expect(isBinaryPayload("0123456789abcdef".repeat(400))).toBe(false);
		const prose = "The quick brown fox jumps over the lazy dog. ".repeat(100);
		expect(isBinaryPayload(prose)).toBe(false);
		const code =
			"const x = {a: 1, b: [2, 3]}; function f() { return x; }\n".repeat(100);
		expect(isBinaryPayload(code)).toBe(false);
	});

	it("keeps the request estimate in line with the per-message estimate", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "image", data: base64Image, mediaType: "image/png" }],
			},
		];
		const request = estimateRequestInputTokens({
			systemPrompt: "sys",
			messages,
			tools: [],
		});
		expect(request).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
		expect(serializeForTokenEstimate(messages)).not.toContain(
			base64Image.slice(0, 100),
		);
	});
});

import { afterEach, expect, test } from "vitest";
import {
	configureArtifactRedaction,
	redactArtifactText,
	serializeArtifact,
} from "./artifact-redaction";
import { StreamRedactor } from "./redaction";

afterEach(() => configureArtifactRedaction([]));
test("quiet command progress is emitted without waiting for another chunk", () => {
	const stream = new StreamRedactor(["fixture-command-secret"]);
	expect(stream.push("fixture-command-secret ready\n")).toBe(
		"[REDACTED] ready\n",
	);
});
test("known secrets and bearer tokens are redacted at every split boundary", () => {
	for (const text of [
		"before long-secret-key after",
		"before Bearer some-token after",
		"before BEARER some-token after",
		"before bearer some-token after",
	]) {
		for (let split = 0; split <= text.length; split++) {
			const stream = new StreamRedactor(["long-secret-key"]);
			const output =
				stream.push(text.slice(0, split)) +
				stream.push(text.slice(split)) +
				stream.flush();
			expect(output).not.toContain("long-secret-key");
			expect(output).not.toContain("some-token");
			expect(output).toContain("[REDACTED]");
		}
	}
});
test("artifact redaction is opt-in and preserves structured data types", () => {
	const value = {
		token: "known-secret",
		nested: [4, true, null, "Bearer unrelated-token"],
	};
	expect(serializeArtifact(value)).toBe(JSON.stringify(value));
	configureArtifactRedaction(["known-secret"]);
	expect(JSON.parse(serializeArtifact(value))).toEqual({
		token: "[REDACTED]",
		nested: [4, true, null, "Bearer [REDACTED]"],
	});
	expect(value.token).toBe("known-secret");
});
test("SQL JSON strings redact escaped secrets without corrupting JSON", () => {
	const secret = 'token-"quoted"\\value';
	configureArtifactRedaction([secret]);
	expect(redactArtifactText(`key=${secret}`)).toBe("key=[REDACTED]");
	expect(
		JSON.parse(redactArtifactText(JSON.stringify({ key: secret }))),
	).toEqual({ key: "[REDACTED]" });
});

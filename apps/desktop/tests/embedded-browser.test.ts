import { expect, test } from "bun:test";
import { browserActionSchema } from "../src/browser-contracts";
import { actionSchema } from "../src/contracts";
import { browserUrl } from "../src/embedded-browser-contracts";

test("embedded navigation accepts web and localhost URLs but rejects privileged schemes and credentials", () => {
	expect(browserUrl("http://localhost:3000/path?q=1")).toBe(
		"http://localhost:3000/path?q=1",
	);
	expect(browserUrl("https://example.com")).toBe("https://example.com/");
	for (const url of [
		"file:///C:/secret",
		"javascript:alert(1)",
		"data:text/html,x",
		"about:blank",
		"https://user:pass@example.com",
		"https://user@example.com",
		"not a URL",
	])
		expect(() => browserUrl(url)).toThrow();
});

test("browser IPC validates layout geometry and tool read operation", () => {
	const bounds = {
		operation: "bounds",
		x: 600,
		y: 100,
		width: 500,
		height: 600,
		visible: true,
	};
	expect(
		actionSchema.safeParse({ type: "embeddedBrowser", command: bounds })
			.success,
	).toBe(true);
	for (const invalid of [
		{ x: -1 },
		{ width: Infinity },
		{ y: NaN },
		{ height: -1 },
		{ visible: "true" },
	])
		expect(
			actionSchema.safeParse({
				type: "embeddedBrowser",
				command: { ...bounds, ...invalid },
			}).success,
		).toBe(false);
	expect(
		browserActionSchema.parse({ operation: "read", tabId: 0 }).operation,
	).toBe("read");
});

import { expect, test } from "bun:test";
import { actionSchema } from "../src/contracts";

const server = {
	id: "9d18b6d5-e502-4ca6-9151-3bfce7277e26",
	name: "mesh-mcp",
	enabled: true,
	type: "http",
	command: "",
	args: [],
	cwd: "",
	url: "http://127.0.0.1:8080/mcp",
	hasSecrets: false,
};

test("Desktop save accepts long MCP timeouts without reducing them", () => {
	for (const timeout of [1, 120, 121, 1000, 3600]) {
		const action = actionSchema.parse({
			type: "saveMcp",
			server: { ...server, timeout },
		});
		if (action.type !== "saveMcp") throw new Error("Unexpected action");
		expect(action.server.timeout).toBe(timeout);
	}
});

test("Desktop rejects timeouts outside the engine range instead of silently clamping", () => {
	for (const timeout of [
		0,
		-1,
		1.5,
		3601,
		30000,
		"1000",
		Number.NaN,
		Infinity,
	]) {
		expect(
			actionSchema.safeParse({
				type: "saveMcp",
				server: { ...server, timeout },
			}).success,
		).toBe(false);
	}
});

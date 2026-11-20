import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readSchema } from "../src/output";

const parent = resolve(import.meta.dir, "../../../ai_output");
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, "cli-schema-"));
afterAll(() => rm(scratch, { recursive: true, force: true, maxRetries: 5 }));

test("validates draft-2020-12 values and standard formats", async () => {
	const path = join(scratch, "2020.json");
	await writeFile(
		path,
		JSON.stringify({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			required: ["date"],
			properties: { date: { type: "string", format: "date-time" } },
		}),
	);
	const schema = await readSchema(path);
	expect(() => schema?.parse('{"date":"not-a-date"}')).toThrow();
	expect(schema?.parse('{"date":"2026-11-20T00:00:00Z"}')).toEqual({
		date: "2026-11-20T00:00:00Z",
	});
});

test("invalid schemas and unresolved references fail before inference", async () => {
	const path = join(scratch, "invalid.json");
	await writeFile(path, "{broken");
	await expect(readSchema(path)).rejects.toMatchObject({
		code: "invalid_schema",
		exitCode: 2,
	});
	await writeFile(
		path,
		JSON.stringify({ $ref: "https://example.invalid/schema.json" }),
	);
	await expect(readSchema(path)).rejects.toMatchObject({
		code: "invalid_schema",
		exitCode: 2,
	});
});

test("malformed schema dialects are input errors, not runtime failures", async () => {
	const path = join(scratch, "dialect.json");
	for (const dialect of [42, {}, [], null, true]) {
		await writeFile(path, JSON.stringify({ $schema: dialect }));
		await expect(readSchema(path)).rejects.toMatchObject({
			code: "invalid_schema",
			exitCode: 2,
		});
	}
});

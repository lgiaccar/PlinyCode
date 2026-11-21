import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { CliError } from "./options";

export async function readSchema(path?: string) {
	if (!path) return undefined;
	let schema: unknown;
	try {
		schema = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new CliError("invalid_schema", `Cannot read output schema: ${error}`);
	}
	const dialect =
		typeof schema === "object" && schema
			? (schema as { $schema?: unknown }).$schema
			: undefined;
	if (dialect !== undefined && typeof dialect !== "string")
		throw new CliError("invalid_schema", "$schema must be a string.");
	const Validator = dialect?.includes("2020-12") ? Ajv2020 : Ajv;
	const ajv = new Validator({
		allErrors: true,
		strict: false,
		strictSchema: true,
	});
	addFormats(ajv);
	try {
		if (
			typeof schema !== "boolean" &&
			(!schema || typeof schema !== "object" || Array.isArray(schema))
		)
			throw new Error("A schema must be an object or boolean.");
		const validate = ajv.compile(schema as object | boolean);
		return {
			schema,
			parse(text: string): unknown {
				let data: unknown;
				try {
					data = JSON.parse(
						text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"),
					);
				} catch {
					throw new CliError(
						"invalid_output",
						"The model did not return valid JSON.",
						4,
					);
				}
				if (!validate(data))
					throw new CliError(
						"invalid_output",
						ajv.errorsText(validate.errors),
						4,
					);
				return data;
			},
		};
	} catch (error) {
		throw new CliError("invalid_schema", `Invalid output schema: ${error}`);
	}
}

export { redact, StreamRedactor, serialize } from "@plinycode/shared/node";

export async function snapshotArtifacts(
	root?: string,
): Promise<Map<string, { size: number; mtime: number }>> {
	const files = new Map<string, { size: number; mtime: number }>();
	if (!root) return files;
	const rootDirectory = root;
	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true }).catch(
			(e: NodeJS.ErrnoException) => {
				if (e.code === "ENOENT") return [];
				throw e;
			},
		);
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) {
				const stat = await lstat(path);
				files.set(relative(rootDirectory, path), {
					size: stat.size,
					mtime: stat.mtimeMs,
				});
			}
		}
	}
	await walk(root);
	return files;
}

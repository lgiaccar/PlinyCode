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

export function redact(text: string, secrets: string[]): string {
	let result = text;
	for (const secret of secrets
		.filter(Boolean)
		.sort((a, b) => b.length - a.length))
		result = result.split(secret).join("[REDACTED]");
	return result.replace(/(Bearer\s+)[\w.+/-]+/gi, "$1[REDACTED]");
}

export function serialize(
	value: unknown,
	secrets: string[],
	indent?: number,
): string {
	return JSON.stringify(
		value,
		(_key, entry) =>
			typeof entry === "string" ? redact(entry, secrets) : entry,
		indent,
	);
}

/** Keep enough trailing text to redact credentials split across model chunks. */
export class StreamRedactor {
	private pending = "";
	constructor(private secrets: string[]) {}
	push(chunk: string): string {
		this.pending += chunk;
		const keep =
			Math.max(1, ...this.secrets.map((secret) => secret.length)) - 1;
		let end = Math.max(0, this.pending.length - keep);
		for (const secret of this.secrets.filter(Boolean)) {
			let start = this.pending.indexOf(secret);
			while (start >= 0) {
				if (start < end && start + secret.length > end) end = start;
				start = this.pending.indexOf(secret, start + secret.length);
			}
		}
		const output = redact(this.pending.slice(0, end), this.secrets);
		this.pending = this.pending.slice(end);
		return output;
	}
	flush(): string {
		const output = redact(this.pending, this.secrets);
		this.pending = "";
		return output;
	}
}

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

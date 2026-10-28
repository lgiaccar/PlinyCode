import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { stripUtf8Bom } from "@plinycode/shared";
import { resolveAgentConfigSearchPaths } from "@plinycode/shared/storage";
import YAML from "yaml";
import { z } from "zod";

const ConfiguredAgentFrontmatterSchema = z.object({
	// name is optional: when absent the file's basename (without extension) is
	// used as the agent's name, matching the GitHub Copilot convention where
	// "fm-dev.agent.md" is implicitly named "fm-dev".
	name: z.string().trim().min(1).optional(),
	description: z.string().trim().min(1).optional(),
	tools: z.union([z.string(), z.array(z.string())]).optional(),
	skills: z.union([z.string(), z.array(z.string())]).optional(),
	providerId: z.string().trim().min(1).optional(),
	modelId: z.string().trim().min(1).optional(),
	maxIterations: z.number().int().positive().optional(),
});

export interface ConfiguredAgentConfig {
	name: string;
	description: string;
	tools?: string[];
	skills?: string[];
	providerId?: string;
	modelId?: string;
	maxIterations?: number;
	systemPrompt: string;
	path?: string;
}

export interface ConfiguredAgentReadError {
	path: string;
	error: Error;
}

export interface ConfiguredAgentLoadResult {
	configs: ConfiguredAgentConfig[];
	errors: ConfiguredAgentReadError[];
}

function splitFrontmatter(content: string): {
	frontmatter: string;
	body: string;
} {
	// Strip a leading UTF-8 BOM (e.g. added by Windows Notepad's "UTF-8 with BOM" encoding),
	// which Node's `utf-8` decoding does not strip on its own. Without this the frontmatter
	// match below never matches a file that starts with "\uFEFF---" (see cline/cline#12151).
	content = stripUtf8Bom(content);

	const firstLineMatch = content.match(/^(---)[^\S\r\n]*(?:\r?\n|$)/);
	if (!firstLineMatch) {
		throw new Error("Missing YAML frontmatter block in agent config file.");
	}

	const frontmatterStart = firstLineMatch[0].length;
	const delimiterPattern = /^---[^\S\r\n]*(?:\r?\n|$)/gm;
	delimiterPattern.lastIndex = frontmatterStart;
	let lastValid:
		| {
				frontmatter: string;
				body: string;
		  }
		| undefined;
	const candidates = Array.from(content.matchAll(delimiterPattern)).filter(
		(candidate) => candidate.index >= frontmatterStart,
	);
	for (const candidate of candidates) {
		const delimiterStart = candidate.index;
		const frontmatter = content.slice(frontmatterStart, delimiterStart);
		try {
			const parsedYaml = YAML.parse(frontmatter);
			if (
				!parsedYaml ||
				typeof parsedYaml !== "object" ||
				Array.isArray(parsedYaml)
			) {
				continue;
			}
			ConfiguredAgentFrontmatterSchema.parse(parsedYaml);
			const body = content.slice(delimiterStart + candidate[0].length);
			lastValid = { frontmatter, body };
		} catch {
			// Keep scanning: this delimiter may be literal content inside YAML.
		}
	}

	if (lastValid) {
		return lastValid;
	}

	throw new Error(
		"Missing closing YAML frontmatter delimiter in agent config file.",
	);
}

function parseStringList(
	value: string | string[] | undefined,
): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const raw = Array.isArray(value) ? value : value.split(",");
	return Array.from(
		new Set(
			raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
		),
	);
}

function normalizeAgentName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Converts a file path to an agent name by stripping the directory and all
 * extensions. For example:
 *   "fm-dev.agent.md"   → "fm-dev"
 *   "code-reviewer.md"  → "code-reviewer"
 *   "reviewer.yml"      → "reviewer"
 */
function fileNameToAgentName(filePath: string): string {
	let name = basename(filePath);
	// Strip all recognised extensions repeatedly (e.g. ".agent.md" → two passes)
	let prev = "";
	while (name !== prev) {
		prev = name;
		const ext = extname(name).toLowerCase();
		if (
			ext === ".md" ||
			ext === ".yml" ||
			ext === ".yaml" ||
			ext === ".agent"
		) {
			name = name.slice(0, -ext.length);
		}
	}
	return name || basename(filePath);
}

/**
 * An agent file is frontmatter plus a prompt body, so `.md` is the natural
 * extension (and the one the Agents tab creates); `.yml`/`.yaml` still load.
 */
function isConfiguredAgentFileName(fileName: string): boolean {
	const extension = extname(fileName).toLowerCase();
	return extension === ".md" || extension === ".yml" || extension === ".yaml";
}

export function parseConfiguredAgentConfig(
	content: string,
	options: { path?: string } = {},
): ConfiguredAgentConfig {
	const { frontmatter, body } = splitFrontmatter(content);
	const parsedYaml = YAML.parse(frontmatter);
	if (
		!parsedYaml ||
		typeof parsedYaml !== "object" ||
		Array.isArray(parsedYaml)
	) {
		throw new Error("Agent config frontmatter must be a YAML mapping.");
	}

	const parsed = ConfiguredAgentFrontmatterSchema.parse(parsedYaml);
	const systemPrompt = body.trim();
	if (!systemPrompt) {
		throw new Error("Missing system prompt body in agent config file.");
	}

	// Derive name from frontmatter; fall back to the file's basename without
	// extension so "fm-dev.agent.md" is implicitly named "fm-dev".
	const fileBaseName = options.path
		? fileNameToAgentName(options.path)
		: undefined;
	const name = parsed.name ?? fileBaseName ?? "unnamed";
	const description = parsed.description ?? "";

	return {
		name,
		description,
		tools: parseStringList(parsed.tools),
		skills: parseStringList(parsed.skills),
		providerId: parsed.providerId,
		modelId: parsed.modelId,
		maxIterations: parsed.maxIterations,
		systemPrompt,
		path: options.path,
	};
}

export function loadConfiguredAgentConfigs(input: {
	workspaceRoot?: string;
	searchPaths?: string[];
}): ConfiguredAgentLoadResult {
	const searchPaths =
		input.searchPaths ?? resolveAgentConfigSearchPaths(input.workspaceRoot);
	const configsByName = new Map<string, ConfiguredAgentConfig>();
	const errors: ConfiguredAgentReadError[] = [];

	for (const directory of searchPaths.filter(Boolean)) {
		loadFromDirectory(directory, configsByName, errors);
	}

	const configs = Array.from(configsByName.values()).sort((a, b) =>
		(a.path ? basename(a.path) : a.name).localeCompare(
			b.path ? basename(b.path) : b.name,
		),
	);
	return { configs, errors };
}

/**
 * Reads all agent files from `directory`, then recurses one level into any
 * subdirectories it finds. This lets workspaces organise agents under
 * `.github/agents/fm-agents/` without having to list each subfolder explicitly
 * in `chat.agentFilesLocations`.
 */
function loadFromDirectory(
	directory: string,
	configsByName: Map<string, ConfiguredAgentConfig>,
	errors: ConfiguredAgentReadError[],
	depth = 0,
): void {
	if (!existsSync(directory)) {
		return;
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		errors.push({
			path: directory,
			error: error instanceof Error ? error : new Error(String(error)),
		});
		return;
	}

	for (const entry of entries) {
		if (entry.isDirectory() && depth === 0) {
			// Recurse exactly one level into subdirectories so that e.g.
			// `.github/agents/fm-agents/fm-dev.agent.md` is discovered
			// automatically without requiring an explicit extra search path.
			loadFromDirectory(join(directory, entry.name), configsByName, errors, 1);
			continue;
		}

		if (!entry.isFile() || !isConfiguredAgentFileName(entry.name)) {
			continue;
		}

		const filePath = join(directory, entry.name);
		try {
			const raw = readFileSync(filePath, "utf8");
			const config = parseConfiguredAgentConfig(raw, { path: filePath });
			const normalizedName = normalizeAgentName(config.name);
			if (!configsByName.has(normalizedName)) {
				configsByName.set(normalizedName, config);
			}
		} catch (error) {
			errors.push({
				path: filePath,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
}

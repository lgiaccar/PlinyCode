import { stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
	createUserInstructionConfigService,
	loadConfiguredAgentConfigs,
	resolveSkillsConfigSearchPaths,
	type SkillConfig,
} from "@plinycode/core";
import { resolveAgentConfigSearchPaths } from "@plinycode/shared/storage";
import { CliError, type Options } from "./options";

// Use the engine's workspace conventions without importing global editor state.
function workspacePaths(root: string, paths: string[]) {
	return paths.filter((path) => {
		const rel = relative(root, path);
		return (
			rel !== ".." &&
			!rel.startsWith("../") &&
			!rel.startsWith("..\\") &&
			!isAbsolute(rel)
		);
	});
}

export async function discover(options: Options, includeRules = false) {
	if (!(await stat(options.cwd).catch(() => undefined))?.isDirectory())
		throw new CliError("invalid_workspace", "--cwd must be a directory.");
	for (const directory of [...options.skillsDirs, ...options.agentsDirs]) {
		if (!(await stat(directory).catch(() => undefined))?.isDirectory())
			throw new CliError(
				"invalid_config_directory",
				`Configuration directory does not exist: ${directory}`,
			);
	}
	const skillsDirs = options.skillsDirs.length
		? options.skillsDirs
		: workspacePaths(options.cwd, resolveSkillsConfigSearchPaths(options.cwd));
	const agentsDirs = options.agentsDirs.length
		? options.agentsDirs
		: workspacePaths(options.cwd, resolveAgentConfigSearchPaths(options.cwd));
	const agents = loadConfiguredAgentConfigs({ searchPaths: agentsDirs });
	const instructions = createUserInstructionConfigService({
		skills: { directories: skillsDirs, includePluginSkills: false },
		rules: includeRules ? { workspacePath: options.cwd } : { directories: [] },
		workflows: { directories: [] },
	});
	try {
		await instructions.start();
	} catch (error) {
		instructions.stop();
		throw error;
	}
	return {
		instructions,
		agents: agents.configs,
		errors: agents.errors.map(({ path, error }) => ({
			path,
			message: error.message,
		})),
		skills: instructions
			.listRecords<SkillConfig>("skill")
			.map(({ id, filePath, item }) => ({
				id,
				name: item.name,
				description: item.description ?? "",
				path: filePath,
				disabled: item.disabled === true,
				warnings: item.warnings ?? [],
			})),
		skillsDirs,
		agentsDirs,
	};
}

export async function listDiscovered(options: Options) {
	const loaded = await discover(options);
	try {
		const skills = options.command === "skills";
		const items = skills
			? loaded.skills
			: loaded.agents.map(({ systemPrompt: _, ...agent }) => agent);
		const report = {
			directories: skills ? loaded.skillsDirs : loaded.agentsDirs,
			items,
			errors: skills ? [] : loaded.errors,
		};
		if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
		else {
			process.stdout.write(
				`Search directories:\n${report.directories.join("\n")}\n\n`,
			);
			for (const item of items) {
				process.stdout.write(
					`${item.name}${"disabled" in item && item.disabled ? " [disabled]" : ""}\t${item.description ?? ""}\n  ${item.path}\n`,
				);
				if ("warnings" in item)
					for (const warning of item.warnings)
						process.stderr.write(`${item.path}: ${warning}\n`);
			}
			if (!items.length) process.stdout.write(`No ${options.command} found.\n`);
			for (const error of report.errors)
				process.stderr.write(`${error.path}: ${error.message}\n`);
		}
	} finally {
		loaded.instructions.stop();
	}
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	GlobalSettingsSchema,
	isAgentPluginDisabledGlobally,
	isModelToolEnabledGlobally,
	readCompactionModeGlobally,
	readCompactionStrategyGlobally,
	readGlobalSettings,
	readPlanActModeGlobally,
	readToolAutoApproveGlobally,
	readTuiThemeGlobally,
	setAutoUpdateEnabledGlobally,
	setCompactionModeGlobally,
	setCompactionStrategyGlobally,
	setDisabledAgentPlugin,
	setDisabledPlugin,
	setDisabledTools,
	setModelToolEnabledGlobally,
	setPlanActModeGlobally,
	setToolAutoApproveGlobally,
	setTuiThemeGlobally,
	writeGlobalSettings,
} from "./global-settings";

describe("global-settings", () => {
	const previousGlobalSettingsPath = process.env.CLINE_GLOBAL_SETTINGS_PATH;

	afterEach(() => {
		process.env.CLINE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
	});

	it("defines the global settings file schema", () => {
		expect(
			GlobalSettingsSchema.parse({
				disabledAgentPlugins: [" portable ", "portable"],
				disabledTools: [" read_files ", "read_files", "editor"],
				disabledPlugins: ["/plugins/example.js", "/plugins/example.js"],
			}),
		).toEqual({
			autoUpdateEnabled: true,
			disabledAgentPlugins: ["portable"],
			disabledPlugins: ["/plugins/example.js"],
			disabledTools: ["editor", "read_files"],
		});
		expect(
			GlobalSettingsSchema.parse({
				disabledTools: [],
				toolAutoApprove: true,
			}),
		).toEqual({ autoUpdateEnabled: true, toolAutoApprove: true });
		expect(GlobalSettingsSchema.parse({ disabledTools: [] })).toEqual({
			autoUpdateEnabled: true,
		});
		expect(
			GlobalSettingsSchema.parse({
				compactionStrategy: "agentic",
				disabledTools: ["read_files"],
				extra: true,
			}),
		).toEqual({
			autoUpdateEnabled: true,
			compactionStrategy: "agentic",
			disabledTools: ["read_files"],
		});
		expect(
			GlobalSettingsSchema.parse({
				disabledTools: 42,
				extra: true,
				toolAutoApprove: true,
			}),
		).toEqual({
			autoUpdateEnabled: true,
			toolAutoApprove: true,
		});
		expect(
			GlobalSettingsSchema.parse({
				autoUpdateEnabled: false,
			}),
		).toEqual({
			autoUpdateEnabled: false,
		});
	});

	it("uses the schema when reading and writing settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			writeGlobalSettings({
				disabledTools: [" editor ", "read_files", "editor"],
				disabledPlugins: [],
			});

			expect(readGlobalSettings()).toEqual({
				autoUpdateEnabled: true,
				disabledTools: ["editor", "read_files"],
			});
			expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
				autoUpdateEnabled: true,
				disabledTools: ["editor", "read_files"],
			});

			await writeFile(
				settingsPath,
				JSON.stringify({
					disabledTools: ["read_files"],
					extra: true,
					toolAutoApprove: true,
				}),
			);
			expect(readGlobalSettings()).toEqual({
				autoUpdateEnabled: true,
				disabledTools: ["read_files"],
				toolAutoApprove: true,
			});

			await writeFile(
				settingsPath,
				JSON.stringify({
					disabledTools: 42,
					extra: true,
					toolAutoApprove: true,
				}),
			);
			expect(readGlobalSettings()).toEqual({
				autoUpdateEnabled: true,
				toolAutoApprove: true,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves disabled tools and both plugin formats across targeted updates", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			setDisabledPlugin("/plugins/example.js", true);
			setDisabledAgentPlugin("portable-review", true);
			setDisabledTools(["read_files", "editor"], true);
			setDisabledTools(["editor"], false);

			expect(readGlobalSettings()).toEqual({
				autoUpdateEnabled: true,
				disabledAgentPlugins: ["portable-review"],
				disabledPlugins: ["/plugins/example.js"],
				disabledTools: ["read_files"],
			});
			expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
				autoUpdateEnabled: true,
				disabledAgentPlugins: ["portable-review"],
				disabledPlugins: ["/plugins/example.js"],
				disabledTools: ["read_files"],
			});

			setDisabledAgentPlugin("portable-review", false);
			expect(isAgentPluginDisabledGlobally("portable-review")).toBe(false);
			expect(readGlobalSettings().disabledAgentPlugins).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stores provider-executed tool preferences in the scalable tools map", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			process.env.CLINE_GLOBAL_SETTINGS_PATH = join(
				root,
				"global-settings.json",
			);

			expect(isModelToolEnabledGlobally("web_search")).toBe(true);
			setModelToolEnabledGlobally("web_search", false);
			expect(isModelToolEnabledGlobally("web_search")).toBe(false);
			expect(readGlobalSettings().tools).toEqual({
				web_search: { enabled: false },
			});

			setDisabledTools(["web_search"], false);
			expect(readGlobalSettings().tools).toEqual({
				web_search: { enabled: true },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed for web search when persisted settings cannot be loaded", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const malformedSettingsPath = join(root, "malformed.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = malformedSettingsPath;
			await writeFile(malformedSettingsPath, "{not json");
			expect(isModelToolEnabledGlobally("web_search")).toBe(false);

			process.env.CLINE_GLOBAL_SETTINGS_PATH = root;
			expect(isModelToolEnabledGlobally("web_search")).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves other settings when auto update is changed", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			writeGlobalSettings({
				disabledTools: ["editor"],
				toolAutoApprove: true,
			});
			setAutoUpdateEnabledGlobally(false);

			expect(readGlobalSettings()).toEqual({
				autoUpdateEnabled: false,
				disabledTools: ["editor"],
				toolAutoApprove: true,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads and writes the compaction strategy globally", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			expect(readCompactionStrategyGlobally()).toBe("agentic");
			setCompactionStrategyGlobally("agentic");
			expect(readCompactionStrategyGlobally()).toBe("agentic");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("normalizes the persisted general settings fields", () => {
		expect(
			GlobalSettingsSchema.parse({
				compactionEnabled: false,
				planActMode: "plan",
				toolAutoApprove: false,
			}),
		).toEqual({
			autoUpdateEnabled: true,
			compactionEnabled: false,
			planActMode: "plan",
			toolAutoApprove: false,
		});
		// Invalid values fall back to unset instead of failing the whole parse.
		expect(
			GlobalSettingsSchema.parse({
				compactionEnabled: "yes",
				planActMode: "chaos",
				toolAutoApprove: 42,
			}),
		).toEqual({
			autoUpdateEnabled: true,
		});
	});

	it("reads and writes the plan/act mode globally", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			expect(readPlanActModeGlobally()).toBeUndefined();
			setPlanActModeGlobally("plan");
			expect(readPlanActModeGlobally()).toBe("plan");
			setPlanActModeGlobally("act");
			expect(readPlanActModeGlobally()).toBe("act");
			expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
				autoUpdateEnabled: true,
				planActMode: "act",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads and writes the tool auto-approve setting globally", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			expect(readToolAutoApproveGlobally()).toBeUndefined();
			setToolAutoApproveGlobally(false);
			expect(readToolAutoApproveGlobally()).toBe(false);
			setToolAutoApproveGlobally(true);
			expect(readToolAutoApproveGlobally()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads and writes the TUI theme globally", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			expect(readTuiThemeGlobally()).toBeUndefined();
			setTuiThemeGlobally("tokyo-night");
			expect(readTuiThemeGlobally()).toBe("tokyo-night");
			expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
				autoUpdateEnabled: true,
				tuiTheme: "tokyo-night",
			});

			// Blank values normalize to unset instead of persisting whitespace.
			writeGlobalSettings({ tuiTheme: "  " });
			expect(readTuiThemeGlobally()).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("round-trips the compaction mode including the off state", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
		try {
			const settingsPath = join(root, "global-settings.json");
			process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

			expect(readCompactionModeGlobally()).toBeUndefined();

			setCompactionModeGlobally("basic");
			expect(readCompactionModeGlobally()).toBe("basic");

			// Turning compaction off retains the previous strategy on disk so
			// re-enabling restores it.
			setCompactionModeGlobally("off");
			expect(readCompactionModeGlobally()).toBe("off");
			expect(readGlobalSettings()).toEqual({
				autoUpdateEnabled: true,
				compactionEnabled: false,
				compactionStrategy: "basic",
			});

			setCompactionModeGlobally("agentic");
			expect(readCompactionModeGlobally()).toBe("agentic");
			expect(readGlobalSettings()).toEqual({
				autoUpdateEnabled: true,
				compactionEnabled: true,
				compactionStrategy: "agentic",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	describe("caching", () => {
		it("invalidates the cache when writeGlobalSettings is called", async () => {
			const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
			try {
				const settingsPath = join(root, "global-settings.json");
				process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;
				writeGlobalSettings({ disabledTools: ["editor"] });
				readGlobalSettings();

				writeGlobalSettings({ disabledTools: ["read_files"] });

				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
					disabledTools: ["read_files"],
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("picks up external writes via mtime change", async () => {
			const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
			try {
				const settingsPath = join(root, "global-settings.json");
				process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;
				writeGlobalSettings({ disabledTools: ["editor"] });
				readGlobalSettings();

				await writeFile(
					settingsPath,
					JSON.stringify({ disabledTools: ["read_files"] }),
				);

				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
					disabledTools: ["read_files"],
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("keys the cache by resolved path so switching files returns the right value", async () => {
			const rootA = await mkdtemp(join(tmpdir(), "core-global-settings-"));
			const rootB = await mkdtemp(join(tmpdir(), "core-global-settings-"));
			try {
				const pathA = join(rootA, "global-settings.json");
				const pathB = join(rootB, "global-settings.json");

				process.env.CLINE_GLOBAL_SETTINGS_PATH = pathA;
				writeGlobalSettings({ disabledTools: ["editor"] });
				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
					disabledTools: ["editor"],
				});

				process.env.CLINE_GLOBAL_SETTINGS_PATH = pathB;
				writeGlobalSettings({ disabledTools: ["read_files"] });
				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
					disabledTools: ["read_files"],
				});

				process.env.CLINE_GLOBAL_SETTINGS_PATH = pathA;
				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
					disabledTools: ["editor"],
				});
			} finally {
				await rm(rootA, { recursive: true, force: true });
				await rm(rootB, { recursive: true, force: true });
			}
		});

		it("returns the default value when the settings file does not exist", async () => {
			const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
			try {
				const settingsPath = join(root, "missing-global-settings.json");
				process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
				});
				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("returns a frozen value so callers cannot mutate the cache", async () => {
			const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
			try {
				const settingsPath = join(root, "global-settings.json");
				process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;
				writeGlobalSettings({
					disabledAgentPlugins: ["portable-review"],
					disabledTools: ["editor"],
					disabledPlugins: ["/plugins/example.js"],
				});

				const settings = readGlobalSettings();

				expect(Object.isFrozen(settings)).toBe(true);
				expect(Object.isFrozen(settings.disabledAgentPlugins)).toBe(true);
				expect(Object.isFrozen(settings.disabledTools)).toBe(true);
				expect(Object.isFrozen(settings.disabledPlugins)).toBe(true);
				expect(() => {
					(settings as { autoUpdateEnabled: boolean }).autoUpdateEnabled =
						false;
				}).toThrow();
				expect(() => {
					settings.disabledTools?.push("malicious");
				}).toThrow();
				expect(isAgentPluginDisabledGlobally("portable-review")).toBe(true);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("transitions from missing-file default to fresh value once the file is created", async () => {
			const root = await mkdtemp(join(tmpdir(), "core-global-settings-"));
			try {
				const settingsPath = join(root, "global-settings.json");
				process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;

				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
				});

				await writeFile(
					settingsPath,
					JSON.stringify({ disabledTools: ["editor"] }),
				);

				expect(readGlobalSettings()).toEqual({
					autoUpdateEnabled: true,
					disabledTools: ["editor"],
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});
});

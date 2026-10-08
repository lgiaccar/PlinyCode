export interface SlashCommand {
	name: string
	description?: string
	section?: "default" | "custom" | "mcp"
	cliCompatible?: boolean
}

export const BASE_SLASH_COMMANDS: SlashCommand[] = [
	// `/newtask` is an alias of `/compact`: condensing achieves its goal
	// (continue working with a fresh, summarized context window) without the
	// legacy new_task tool. The webview intercepts all three spellings and
	// runs the condense RPC (see useMessageHandlers.handleSendMessage).
	{
		name: "newtask",
		description: "Condenses the current task and continues with a fresh context window",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "deep-planning",
		description: "Create a comprehensive implementation plan before coding",
		section: "default",
		cliCompatible: true,
	},
	// NOTE: legacy's /newrule and /reportbug are hidden until their prompt
	// expansions are ported to the SDK runtime — without expansion the literal
	// command text reaches the model, which silently degrades to plain chat.
	{
		name: "compact",
		description: "Condenses your current context window",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "smol",
		description: "Alias for /compact",
		section: "default",
		cliCompatible: true,
	},
	// Repo memory (docs/memory.md). /remember expands into instructions to call
	// save_memory; /distill is intercepted by the webview and runs the distill RPC.
	{
		name: "remember",
		description: "Save something to this repository's memory (or yours) for later conversations",
		section: "default",
		cliCompatible: false,
	},
	{
		name: "distill",
		description: "Propose memories worth keeping from this conversation",
		section: "default",
		cliCompatible: false,
	},
]

// VS Code-only slash commands
export const VSCODE_ONLY_COMMANDS: SlashCommand[] = []

export const VSC_TITLEBAR_INACTIVE_FOREGROUND = "--vscode-titleBar-inactiveForeground"

export function getAsVar(varName: string): string {
	return `var(${varName})`
}

import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.review.*` setting. */
const REVIEW_SETTINGS_SECTION = "plinycode.review"

/**
 * `plinycode.review.beforeFinish`: whether a second free model reads the diff
 * of a FreeAuto / BalanceAuto run before it ends (sdk/router/router-review.ts).
 */
const BEFORE_FINISH_SETTING = "beforeFinish"

/** On unless the user switched it off. Read per run, so a change applies to the next one. */
export function isReviewBeforeFinishEnabled(): boolean {
	try {
		return vscode.workspace.getConfiguration(REVIEW_SETTINGS_SECTION).get<boolean>(BEFORE_FINISH_SETTING, true) !== false
	} catch {
		// Hosts without VS Code's configuration API (standalone) keep the default.
		return true
	}
}

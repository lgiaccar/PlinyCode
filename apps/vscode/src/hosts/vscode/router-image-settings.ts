import * as vscode from "vscode"
import { normalizeRouterImageMode, type RouterImageMode } from "@/sdk/router/router-images"

/**
 * `plinycode.router.images`: what FreeAuto and BalanceAuto do with an image a
 * model they route to cannot see (sdk/router/router-images.ts). Read on every
 * routed call with images, so a change applies to running conversations.
 */
export function getRouterImageMode(): RouterImageMode {
	try {
		return normalizeRouterImageMode(vscode.workspace.getConfiguration("plinycode.router").get("images"))
	} catch {
		// Hosts without VS Code's configuration API (standalone) keep the default.
		return normalizeRouterImageMode(undefined)
	}
}

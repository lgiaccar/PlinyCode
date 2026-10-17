import * as vscode from "vscode"

import { OpenFolderInNewWindowRequest, OpenFolderInNewWindowResponse } from "@/shared/proto/index.host"

export async function openFolderInNewWindow(request: OpenFolderInNewWindowRequest): Promise<OpenFolderInNewWindowResponse> {
	if (request.path) {
		await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(request.path), { forceNewWindow: true })
	}
	return {}
}

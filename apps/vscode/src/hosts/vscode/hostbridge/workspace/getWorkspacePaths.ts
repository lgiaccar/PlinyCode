import * as vscode from "vscode"
import { GetWorkspacePathsRequest, GetWorkspacePathsResponse } from "@/shared/proto/index.host"

export async function getWorkspacePaths(_: GetWorkspacePathsRequest): Promise<GetWorkspacePathsResponse> {
	const paths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
	// Only a saved .code-workspace file identifies a workspace; an untitled
	// workspace has a workspaceFile too, but with an "untitled:" scheme.
	const workspaceFile = vscode.workspace.workspaceFile
	return GetWorkspacePathsResponse.create({
		paths,
		...(workspaceFile?.scheme === "file" ? { workspaceFile: workspaceFile.fsPath } : {}),
	})
}

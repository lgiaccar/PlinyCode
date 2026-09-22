import path from "path"
import * as vscode from "vscode"
import { OpenDiffRequest, OpenDiffResponse } from "@/shared/proto/index.host"
import { getCwd } from "@/utils/path"
import { DIFF_VIEW_URI_SCHEME } from "../../VscodeDiffContentProvider"

export async function openDiff(request: OpenDiffRequest): Promise<OpenDiffResponse> {
	const filePath = request.path?.trim()
	if (!filePath) {
		throw new Error("openDiff requires a file path")
	}

	const left = request.leftContent ?? ""
	const right = request.rightContent ?? request.content ?? ""
	const cwd = await getCwd()
	const relativePath = path.relative(cwd, filePath) || path.basename(filePath)
	const uriPath = relativePath.replace(/\\/g, "/")

	const leftUri = vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${uriPath}`).with({
		query: Buffer.from(left).toString("base64"),
	})
	const rightUri = vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${uriPath}`).with({
		query: Buffer.from(right).toString("base64"),
	})

	const title = request.title?.trim() || relativePath
	await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
		preview: false,
	})

	return { diffId: filePath }
}

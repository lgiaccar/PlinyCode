import type { AddCiTargetRequest } from "@shared/proto/cline/ci_board"
import { String } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { CiTargetInput } from "@/services/devops-mcp/ci-board/ci-board"
import type { Controller } from "../index"

/** Adds a pull request link, a branch or a repository's open PRs to the CI board. */
export async function addCiTarget(_controller: Controller, request: AddCiTargetRequest): Promise<String> {
	const board = getCiBoard()
	if (!board) {
		throw new Error("The CI board is not available.")
	}
	let input: CiTargetInput
	switch (request.kind) {
		case "pr":
			input = { kind: "pr", url: request.input }
			break
		case "branch":
			input = { kind: "branch", repoRoot: request.repoRoot, branch: request.input }
			break
		case "repo":
			input = { kind: "repo", repoRoot: request.repoRoot, prFilter: request.prFilter === "all" ? "all" : "mine" }
			break
		default:
			throw new Error(`Unknown CI board target kind "${request.kind}".`)
	}
	const target = await board.addTarget(input)
	return String.create({ value: target.id })
}

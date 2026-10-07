import { type CiRepo, CiRepoList } from "@shared/proto/cline/ci_board"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { HostProvider } from "@/hosts/host-provider"
import { loadContext } from "@/services/devops-mcp/server/repo"
import type { Controller } from "../index"

/** The window's folders that are git repositories with a GitHub or Azure DevOps remote. */
export async function listCiRepos(_controller: Controller, _request: EmptyRequest): Promise<CiRepoList> {
	const { paths } = await HostProvider.workspace.getWorkspacePaths({})
	const repos: CiRepo[] = []
	for (const folder of paths ?? []) {
		try {
			const ctx = await loadContext(folder)
			if (!repos.some((r) => r.root === ctx.root)) {
				repos.push({
					root: ctx.root,
					remoteUrl: ctx.remoteUrl ?? "",
					provider: ctx.remote.kind,
					currentBranch: ctx.branch ?? "",
				})
			}
		} catch {
			// not a repository with a supported remote
		}
	}
	return CiRepoList.create({ repos })
}

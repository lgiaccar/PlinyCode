import path from "node:path"
import { resolveClineDataDir } from "@plinycode/shared/storage"
import { workspaceRefFromWindow } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { setPipelineManager } from "../builtin-mcp-registry"
import type { ProviderCache } from "../ci-watch/ci-watch-source"
import { PipelineManager } from "../pipelines/pipeline-manager"
import { PipelineRunStore } from "../pipelines/pipeline-run-store"
import type { PipelineProvider } from "../server/providers/types"
import { loadContext } from "../server/repo"

export class PipelineHost {
	private manager?: PipelineManager
	private disposed = false

	static start(providers: ProviderCache): PipelineHost {
		const host = new PipelineHost()
		host.init(providers).catch((error) => Logger.error("[Pipelines] Failed to start:", error))
		return host
	}

	private async init(providers: ProviderCache): Promise<void> {
		const window = workspaceRefFromWindow(await HostProvider.workspace.getWorkspacePaths({}))
		if (this.disposed) return
		this.manager = new PipelineManager({
			store: new PipelineRunStore(path.join(resolveClineDataDir(), "pipeline-runs"), window?.path ?? ""),
			providerFor: (remote) => providers.forRemote(remote) as PipelineProvider,
			repositories: async () => {
				const { paths } = await HostProvider.workspace.getWorkspacePaths({})
				const roots = await Promise.all(
					(paths ?? []).map(async (folder) => {
						try {
							return (await loadContext(folder)).root
						} catch {
							return undefined
						}
					}),
				)
				return roots.filter((root): root is string => root !== undefined)
			},
		})
		setPipelineManager(this.manager)
		await this.manager.init()
		if (this.disposed) this.manager.dispose()
	}

	dispose(): void {
		this.disposed = true
		this.manager?.dispose()
		setPipelineManager(undefined)
	}
}

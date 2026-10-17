import path from "node:path"
import { resolveClineDataDir } from "@plinycode/shared/storage"
import * as vscode from "vscode"
import { workspaceRefFromWindow } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"
import { setPipelineManager } from "../builtin-mcp-registry"
import type { ProviderCache } from "../ci-watch/ci-watch-source"
import { PipelineManager } from "../pipelines/pipeline-manager"
import { type PipelineLaunch, PipelineRunStore } from "../pipelines/pipeline-run-store"
import type { PipelineProvider } from "../server/providers/types"
import { loadContext } from "../server/repo"

const SETTING_NOTIFY = "plinycode.pipelines.notify"
const OPEN_RUN = "Open run"
const OPEN_PIPELINES = "Open Pipelines"
/** A run found finished long after its launch (the window was closed meanwhile) is not news any more. */
const NOTIFY_WITHIN_MS = 24 * 60 * 60_000

const OUTCOMES: Record<string, string> = {
	success: "succeeded",
	failure: "failed",
	cancelled: "was cancelled",
	partial: "partially succeeded",
	skipped: "was skipped",
}

/** The notification text for a finished launch, e.g. "Pipeline Deploy on main (started by the agent) failed." */
function completionMessage(launch: PipelineLaunch): string {
	const result = launch.run?.result ?? ""
	const by = launch.origin === "agent" ? " (started by the agent)" : launch.origin === "rerun" ? " (rerun)" : ""
	return `Pipeline ${launch.pipeline.name} on ${launch.ref}${by} ${OUTCOMES[result] ?? `finished: ${result || "unknown"}`}.`
}

export class PipelineHost {
	private manager?: PipelineManager
	private disposed = false

	private constructor(private readonly openView?: () => Promise<void>) {}

	/** `openView` shows the Pipelines view; without it the notifications offer only the run. */
	static start(providers: ProviderCache, openView?: () => Promise<void>): PipelineHost {
		const host = new PipelineHost(openView)
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
		this.manager.onRunCompleted((launch) => void this.notify(launch))
		setPipelineManager(this.manager)
		await this.manager.init()
		if (this.disposed) this.manager.dispose()
	}

	private async notify(launch: PipelineLaunch): Promise<void> {
		if (
			!vscode.workspace.getConfiguration().get<boolean>(SETTING_NOTIFY, true) ||
			Date.now() - launch.created > NOTIFY_WITHIN_MS
		) {
			return
		}
		const { selectedOption } = await HostProvider.window.showMessage({
			type: launch.run?.result === "success" ? ShowMessageType.INFORMATION : ShowMessageType.WARNING,
			message: completionMessage(launch),
			options: { items: this.openView ? [OPEN_RUN, OPEN_PIPELINES] : [OPEN_RUN] },
		})
		if (selectedOption === OPEN_RUN) {
			await openExternal(launch.url)
		} else if (selectedOption === OPEN_PIPELINES) {
			await this.openView?.()
		}
	}

	dispose(): void {
		this.disposed = true
		this.manager?.dispose()
		setPipelineManager(undefined)
	}
}

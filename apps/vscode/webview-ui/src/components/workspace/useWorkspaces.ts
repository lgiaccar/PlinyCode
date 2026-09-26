import { EmptyRequest } from "@shared/proto/cline/common"
import { PickWorkspaceRequest, type Workspace } from "@shared/proto/cline/workspace"
import { parseWorkspaceKind, type WorkspaceKind, type WorkspaceRef, workspaceRefsEqual } from "@shared/workspaceRef"
import { useCallback, useEffect, useState } from "react"
import { WorkspaceServiceClient } from "@/services/grpc-client"

export function workspaceFromProto(proto: Workspace): WorkspaceRef {
	return {
		path: proto.path,
		kind: parseWorkspaceKind(proto.kind),
		folders: proto.folders ?? [],
		...(proto.lastUsedTs ? { lastUsedTs: proto.lastUsedTs } : {}),
	}
}

export interface WorkspacesState {
	/** The window's workspace; undefined in an empty window or before loading. */
	current: WorkspaceRef | undefined
	/** Recently used workspaces, newest first, without the current one. */
	recent: WorkspaceRef[]
	loaded: boolean
	reload: () => Promise<void>
	/** Opens the native picker; resolves to the chosen workspace, or undefined when cancelled. */
	pick: (kind: WorkspaceKind) => Promise<WorkspaceRef | undefined>
}

/**
 * The workspaces a conversation can be started in or filtered by: the window's
 * own and the recently used ones. Re-read from the extension on every mount
 * (and on `reload`), because other PlinyCode windows add to the list too.
 */
export function useWorkspaces(): WorkspacesState {
	const [current, setCurrent] = useState<WorkspaceRef | undefined>(undefined)
	const [recent, setRecent] = useState<WorkspaceRef[]>([])
	const [loaded, setLoaded] = useState(false)

	const reload = useCallback(async () => {
		try {
			const list = await WorkspaceServiceClient.listRecentWorkspaces(EmptyRequest.create({}))
			const currentRef = list.current?.path ? workspaceFromProto(list.current) : undefined
			setCurrent(currentRef)
			setRecent((list.recent ?? []).map(workspaceFromProto).filter((entry) => !workspaceRefsEqual(entry, currentRef)))
		} catch (error) {
			console.error("Failed to load workspaces:", error)
		} finally {
			setLoaded(true)
		}
	}, [])

	useEffect(() => {
		void reload()
	}, [reload])

	const pick = useCallback(
		async (kind: WorkspaceKind) => {
			try {
				const picked = await WorkspaceServiceClient.pickWorkspace(PickWorkspaceRequest.create({ kind }))
				if (!picked.path) {
					return undefined
				}
				await reload()
				return workspaceFromProto(picked)
			} catch (error) {
				console.error("Failed to pick a workspace:", error)
				return undefined
			}
		},
		[reload],
	)

	return { current, recent, loaded, reload, pick }
}

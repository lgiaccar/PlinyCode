/**
 * Where plan mode keeps a workspace's plans (docs/plan-mode.md#plan-files):
 * `<data dir>/plans/<workspace name>-<hash>/<slug>/PLAN.md`. The folder is
 * outside the workspace, so a plan is never committed or deleted with it, and
 * the same workspace always gets the same folder back.
 */
import { createHash } from "node:crypto"
import { existsSync, promises as fs } from "node:fs"
import path from "node:path"
import { resolvePlansDataDir } from "@plinycode/shared/storage"

/** The plans folder of the workspace at `workspaceRoot`. */
export function workspacePlanFolder(workspaceRoot: string, plansRoot = resolvePlansDataDir()): string {
	const resolved = path.resolve(workspaceRoot)
	// One folder per workspace however its path is spelled: Windows paths are case-insensitive.
	const comparable = process.platform === "win32" ? resolved.toLowerCase() : resolved
	const hash = createHash("sha256").update(comparable).digest("hex").slice(0, 8)
	const name =
		path
			.basename(resolved)
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "") || "workspace"
	return path.join(plansRoot, `${name}-${hash}`)
}

interface SavedPlan {
	/** The plan's folder name (its slug). */
	slug: string
	/** The root file: PLAN.md, else the first markdown file in the folder. */
	file: string
	/** Last change to the root file (ms since epoch). */
	modifiedTs: number
}

/** The plans saved in `folder`, newest first. */
export async function listSavedPlans(folder: string): Promise<SavedPlan[]> {
	if (!existsSync(folder)) {
		return []
	}
	const entries = await fs.readdir(folder, { withFileTypes: true })
	const plans: SavedPlan[] = []
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}
		const dir = path.join(folder, entry.name)
		const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => /\.(md|markdown)$/i.test(name)).sort()
		const root = files.find((name) => name.toLowerCase() === "plan.md") ?? files[0]
		if (!root) {
			continue
		}
		const file = path.join(dir, root)
		const stat = await fs.stat(file).catch(() => undefined)
		plans.push({ slug: entry.name, file, modifiedTs: stat?.mtimeMs ?? 0 })
	}
	return plans.sort((a, b) => b.modifiedTs - a.modifiedTs)
}

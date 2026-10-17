/**
 * Where the CI board writes failure reports: `.plinycode/ci-reports/` in the
 * repository's checkout, kept out of git through `.git/info/exclude` so no
 * tracked `.gitignore` changes. A worktree shares its repository's exclude
 * file (`git rev-parse --git-common-dir`), so its runs see the folder ignored
 * too.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { git } from "@/services/git/worktrees"

const REPORT_FOLDER = ".plinycode"
const EXCLUDE_LINE = `/${REPORT_FOLDER}/`

const ensured = new Map<string, Promise<string>>()

/** Creates the checkout's report folder and its exclude entry once; returns the folder. */
export function ensureReportDir(checkout: string): Promise<string> {
	const resolved = path.resolve(checkout)
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved
	let pending = ensured.get(key)
	if (!pending) {
		pending = prepare(checkout)
		ensured.set(key, pending)
		pending.catch(() => ensured.delete(key))
	}
	return pending
}

async function prepare(checkout: string): Promise<string> {
	const dir = path.join(checkout, REPORT_FOLDER, "ci-reports")
	await fs.mkdir(dir, { recursive: true })
	const common = await git(checkout, ["rev-parse", "--git-common-dir"], 15_000)
	if (common.ok && common.stdout) {
		const infoDir = path.join(path.resolve(checkout, common.stdout), "info")
		const exclude = path.join(infoDir, "exclude")
		let text = ""
		try {
			text = await fs.readFile(exclude, "utf8")
		} catch {
			// no exclude file yet
		}
		if (!text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_LINE)) {
			await fs.mkdir(infoDir, { recursive: true })
			const prefix = text && !text.endsWith("\n") ? "\n" : ""
			await fs.appendFile(exclude, `${prefix}# PlinyCode CI board reports\n${EXCLUDE_LINE}\n`, "utf8")
		}
	}
	return dir
}

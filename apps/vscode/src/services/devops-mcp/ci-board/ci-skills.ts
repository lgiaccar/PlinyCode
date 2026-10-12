/**
 * Finds the repository's own skills for the CI board's built-in actions (e.g.
 * `.github/skills/fix-conflicts`, `recalibrate-unit-tests`), so a run is told
 * to follow them instead of the board's generic steps. Skills are matched by
 * name only. No `vscode` import.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { getSkillsDirectoriesForScan } from "@/core/storage/skill-directories"
import { stripFrontmatter } from "./ci-prompt"
import type { CiBuiltinId } from "./types"

export interface CiSkill {
	name: string
	/** The SKILL.md or skill file. */
	path: string
}

export type CiSkills = Record<CiBuiltinId, CiSkill[]>

const PATTERNS: Record<CiBuiltinId, RegExp> = {
	"fix-conflicts": /conflict/i,
	recalibrate: /recalibrat|re-?baseline|golden/i,
	"fix-ci": /pipeline|ci[-_]?fail|triage|delta|analy[sz]e/i,
	investigate: /pipeline|ci[-_]?fail|triage|delta|analy[sz]e/i,
}

const CACHE_MS = 60_000

const cache = new Map<string, { at: number; skills: Promise<CiSkill[]> }>()

export const noSkills = (): CiSkills => ({ "fix-conflicts": [], recalibrate: [], "fix-ci": [], investigate: [] })

/** The skills under `root` that fit each built-in action, project skills first. */
export async function detectCiSkills(root: string, now = Date.now()): Promise<CiSkills> {
	let entry = cache.get(root)
	if (!entry || now - entry.at > CACHE_MS) {
		entry = { at: now, skills: listSkills(root) }
		cache.set(root, entry)
	}
	const skills = await entry.skills
	const out = noSkills()
	for (const id of Object.keys(PATTERNS) as CiBuiltinId[]) {
		out[id] = skills.filter((s) => PATTERNS[id].test(s.name))
	}
	return out
}

async function listSkills(root: string): Promise<CiSkill[]> {
	const found: CiSkill[] = []
	const seen = new Set<string>()
	// The repository's own skills only: a user-wide skill does not know this repository's tooling.
	for (const dir of getSkillsDirectoriesForScan(root).filter((d) => d.source === "project")) {
		let entries: import("node:fs").Dirent[]
		try {
			entries = await fs.readdir(dir.path, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			let file: string
			let fallback: string
			if (entry.isDirectory()) {
				file = path.join(dir.path, entry.name, "SKILL.md")
				fallback = entry.name
			} else if (/\.mdc?$/i.test(entry.name)) {
				file = path.join(dir.path, entry.name)
				fallback = entry.name.replace(/\.mdc?$/i, "")
			} else {
				continue
			}
			// A folder without SKILL.md is not a skill.
			const name = await skillName(file, fallback)
			if (!name) continue
			const key = name.toLowerCase()
			if (seen.has(key)) continue
			seen.add(key)
			found.push({ name, path: file })
		}
	}
	return found
}

/** The `name:` from the file's front matter, else `fallback`; undefined when the file cannot be read. */
async function skillName(file: string, fallback: string): Promise<string | undefined> {
	let text: string
	try {
		text = await fs.readFile(file, "utf8")
	} catch {
		return undefined
	}
	const frontmatter = text.slice(0, text.length - stripFrontmatter(text).length)
	const match = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter)
	return match?.[1]?.trim() || fallback
}

import { describe, expect, it } from "vitest"
import { renderMemorySection, renderSubAgentMemoryExcerpt } from "./memory-section"
import type { MemoryContents } from "./memory-store"

/** The excerpt budget in memory-section.ts. */
const SUB_AGENT_MEMORY_EXCERPT_CHARS = 2000

function contents(repoText: string, userText = ""): MemoryContents {
	return {
		location: {
			repo: { key: "k", identity: "github.com/org/repo", kind: "remote" },
			repoDir: "/m/repos/k",
			repoFile: "/m/repos/k/MEMORY.md",
			userDir: "/m/user",
			userFile: "/m/user/MEMORY.md",
		} as MemoryContents["location"],
		repoText,
		userText,
		repoTopics: [],
		userTopics: [],
	}
}

describe("renderMemorySection budget", () => {
	it("counts the instructions, topic list and the cut-entries note against the budget", () => {
		const entries = Array.from({ length: 300 }, (_, i) => `- fact number ${i} with a little padding`).join("\n")
		const topics = Array.from({ length: 30 }, (_, i) => ({
			path: `/m/repos/k/topic-${i}.md`,
			summary: `Topic ${i} summary that is reasonably long`,
		}))
		const section = renderMemorySection(
			{ ...contents(`# Repository memory\n\n## Notes\n\n${entries}\n`), repoTopics: topics },
			1000,
		)
		const text = section?.text ?? ""
		// The whole section, instructions included, stays near the 3,000-character budget.
		expect(text.length).toBeLessThanOrEqual(1000 * 3 + 400)
		// At most 12 topic files are listed; the rest are counted.
		expect(text.match(/topic-\d+\.md/g)).toHaveLength(12)
		expect(text).toContain("… 18 more in the folder of")
		expect(section?.summary.droppedEntries).toBeGreaterThan(0)
	})
})

describe("renderSubAgentMemoryExcerpt", () => {
	it("gives a sub-agent the repository's important entries, read-only, and nothing else", () => {
		const section = renderMemorySection(
			contents(
				"# Repository memory\n\n## Important\n\n- PRs target stage\n- Run build:sdk after engine changes\n\n## Notes\n\n- Biome formats only the files you pass\n",
				"# My memory\n\n## Important\n\n- Answer briefly\n",
			),
			4000,
		)
		const excerpt = renderSubAgentMemoryExcerpt(section?.text)
		expect(excerpt).toContain("read-only excerpt")
		expect(excerpt).toContain("- PRs target stage")
		expect(excerpt).toContain("- Run build:sdk after engine changes")
		expect(excerpt).not.toContain("Biome formats")
		expect(excerpt).not.toContain("Answer briefly")
		expect(excerpt).toContain("You cannot save memories")
	})

	it("is empty when the repository has no important entries, or memory is off", () => {
		const section = renderMemorySection(contents("# Repository memory\n\n## Notes\n\n- a note\n"), 4000)
		expect(renderSubAgentMemoryExcerpt(section?.text)).toBeUndefined()
		expect(renderSubAgentMemoryExcerpt(undefined)).toBeUndefined()
	})

	it("cuts a long list at a line boundary within the budget", () => {
		const entries = Array.from({ length: 200 }, (_, i) => `- important fact number ${i} with some padding text`).join("\n")
		const section = renderMemorySection(contents(`# Repository memory\n\n## Important\n\n${entries}\n`), 64_000)
		const excerpt = renderSubAgentMemoryExcerpt(section?.text) ?? ""
		const body = excerpt.slice(excerpt.indexOf("\n\n- ") + 2)
		expect(body.length).toBeLessThanOrEqual(SUB_AGENT_MEMORY_EXCERPT_CHARS + 10)
		expect(excerpt.endsWith("- […]")).toBe(true)
		expect(excerpt).toContain("- important fact number 0 ")
	})
})

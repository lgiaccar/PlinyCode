// What a memory entry must not be (docs/memory.md, "What is not saved").
//
// A repository's memory once gained twenty entries in a day that recorded
// what each task changed ("Fixed LineFilterBuf::sync() bug", "Added
// FieldIsExpected helper", "GPUSurfer CLI MSH output now uses PmdatParser"),
// most of them under Important, each then sent with every request for that
// repository. The gate here runs on every write path (the save_memory tool,
// distill proposals saved from the chat row) and on the cleanup proposals
// that offer the existing ones for removal.

/** Only the start of an entry is looked at: that is where a change log announces itself. */
const CHANGE_LOG_WINDOW_CHARS = 60

const CHANGE_LOG_VERB =
	/\b(added|updated|created|removed|renamed|expanded|implemented|fixed|refactored|replaced|introduced|changed|moved|extended|wrote|rewrote|deleted|migrated|merged|reworked|now (?:uses?|outputs?|shows?|has|have|supports?|includes?|writes?|reads?|returns?|does|emits?)|no longer)\b/i

/**
 * "must be updated", "should be renamed", "never changed": a rule about what
 * to do, not a record of what was done. A modal before the verb clears it.
 */
const RULE_MODAL =
	/\b(must|should|needs? to|has to|have to|always|never|do not|don'?t|can(?:not|'t)?|will|would|if|when|unless|before|after)\b/i

/** "In foo.py, add …": an instruction that was carried out, written as a memory. */
const FILE_INSTRUCTION = /^in\s+\S+\.[a-z0-9]{1,5},?\s+(add|change|update|remove|rename|replace|move|insert|append|expand)\b/i

const TASK_BOUND =
	/\b(this (task|pr|pull request|conversation|session|branch|commit)|the current (pr|pull request|task|branch|commit)|current pending commit)\b/i
const CODE_FACT =
	/\b(takes|accepts|returns|requires|expects|has no|lacks)\b.*\b(argument|parameter|constructor|overload|signature|return type)s?\b/i

/**
 * True when an entry records what a task changed, is bound to one task, or
 * restates something a search of the code would show. Such text belongs in
 * git, not in a memory that is sent with every request.
 */
export function looksLikeChangeLog(text: string): boolean {
	// A task narrative can masquerade as a rule by putting "When" in front.
	if (/^when\s+(?:resolving|instrumenting|implementing|refactoring|merging)\b/i.test(text)) {
		const condition = text.split(",")[0]
		if (condition.split(/\s+/).length > 12 || /\b\w+\.(?:cxx|cpp|ts|tsx|py)\b/i.test(condition)) return true
	}
	if (/\b\w+\.(?:cxx|cpp|ts|tsx|py)\b.*\b(?:added|fixed|changed|renamed|replaced)\b/i.test(text)) return true
	const head = text.slice(0, CHANGE_LOG_WINDOW_CHARS)
	const verb = head.match(CHANGE_LOG_VERB)
	if (verb && verb.index !== undefined) {
		const before = head.slice(0, verb.index)
		if (!RULE_MODAL.test(before)) {
			return true
		}
	}
	return FILE_INSTRUCTION.test(text) || TASK_BOUND.test(text) || CODE_FACT.test(text)
}

const RULE_WORDS = /\b(when|must|never|always|avoid|use|requires?|do not|don'?t|instead|or|before|after|if|unless|only|not)\b/i

/**
 * Whether an entry reads as a rule or a gotcha ("when X, do Y", "never Z",
 * "use A instead of B"): what the Important section is for. A plain statement
 * of fact earns a place under Notes.
 */
export function readsAsRule(text: string): boolean {
	return RULE_WORDS.test(text)
}

/** How a write was refused or adjusted, for the caller to explain. */
export type MemorySaveRejection = "change-log" | "conversation-cap"
export type MemoryImportanceDemotion = "not-a-rule" | "important-full"

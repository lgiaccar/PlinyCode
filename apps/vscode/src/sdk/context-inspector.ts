import { type AgentModelRequest, estimateRequestInputTokens } from "@plinycode/shared"
import type { ContextInspection, ContextSection, ContextSnapshot } from "@shared/context-inspector"

const captures = new Map<string, { sequence: number; requests: ContextSnapshot[] }>()
const MAX_CONVERSATIONS = 8
const MAX_REQUESTS = 3
const MAX_CHARACTERS = 180_000
const MAX_SECTION_CHARACTERS = 24_000
const MAX_SECTIONS = 160

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Capture strings immediately. Later mutation of the request must not rewrite history. */
export function captureContextRequest(sessionId: string, modelId: string, at: number, request: AgentModelRequest): void {
	const previous = captures.get(sessionId)
	const id = (previous?.sequence ?? 0) + 1
	const sections: ContextSection[] = []
	const notices = [
		"Captured before provider conversion and router selection. Counts are estimates, not provider billing.",
		"The engine does not enumerate every excluded source here. Missing content is not proof that it was deliberately excluded.",
	]
	let remaining = MAX_CHARACTERS
	let omittedSections = 0
	const add = (label: string, value: unknown) => {
		if (sections.length >= MAX_SECTIONS || remaining <= 0) {
			omittedSections++
			return
		}
		let partial = false
		let text =
			typeof value === "string"
				? value
				: (JSON.stringify(
						value,
						(_key, field) => {
							if (typeof field === "string" && field.length > MAX_SECTION_CHARACTERS) {
								partial = true
								return `${field.slice(0, MAX_SECTION_CHARACTERS)}\n[Preview shortened]`
							}
							return field
						},
						2,
					) ?? "")
		const limit = Math.min(remaining, MAX_SECTION_CHARACTERS)
		if (text.length > limit) {
			text = text.slice(0, limit)
			partial = true
		}
		remaining -= text.length
		sections.push({ label, content: text, partial })
	}
	let estimatedTokens = 0
	try {
		estimatedTokens = estimateRequestInputTokens({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
		})
		const sources = record(record(request.options?.metadata)?.contextSources)
		let system = request.systemPrompt ?? ""
		for (const [field, label] of [
			["rulesText", "Rules"],
			["memoryText", "Memory"],
		] as const) {
			const source = sources?.[field]
			if (typeof source === "string" && source) {
				if (system.includes(source)) {
					add(label, source)
					system = system.replace(source, "")
				} else
					notices.push(
						`${label} metadata was not found verbatim in System; inspect the captured System content for partial inclusion.`,
					)
			}
		}
		if (system) add("System (excluding sources shown separately)", system)
		for (const message of request.messages) {
			for (const part of message.content) {
				const prefix = `${message.role} · ${message.id}`
				if (part.type === "image" || part.type === "media") {
					add(`Attachments · ${prefix}`, {
						type: part.type,
						note: "Media was included in this request; its binary payload is not retained in this preview.",
					})
				} else if (part.type === "tool-result" || part.type === "tool-call") {
					add(`${part.type === "tool-result" ? "Tool results" : "Tool calls"} · ${part.toolName} · ${prefix}`, part)
				} else if (part.type === "file") {
					add(`Attachments · ${part.path} · ${prefix}`, part.content)
				} else {
					let text = part.text
					for (const [field, label] of [
						["skillTexts", "Skills"],
						["workflowTexts", "Workflows"],
					] as const) {
						const bodies = sources?.[field]
						if (Array.isArray(bodies))
							for (const body of bodies) {
								if (typeof body === "string" && body.length >= 32 && text.includes(body)) {
									add(`${label} · ${prefix}`, body)
									text = text.replace(body, "")
								}
							}
					}
					if (text)
						add(
							`Conversation${message.metadata?.kind === "compaction_summary" ? " · summary" : ""} · ${part.type} · ${prefix}`,
							text,
						)
				}
			}
		}
		for (const tool of request.tools) add(`Tool definitions · ${tool.name}`, tool)
		if (request.modelTools?.length) add("Provider tool definitions", request.modelTools)
	} catch {
		notices.push("Some request content could not be captured. This preview is incomplete.")
	}
	if (omittedSections)
		notices.push(
			`${omittedSections} sections are omitted from this preview because its size limit was reached; this did not change the sent request.`,
		)
	if (sections.some((section) => section.partial))
		notices.push("Some previews are shortened. The sent request was not shortened by the inspector.")
	const snapshot = { id, at, modelId, estimatedTokens, sections, notices }
	captures.delete(sessionId)
	captures.set(sessionId, { sequence: id, requests: [...(previous?.requests ?? []), snapshot].slice(-MAX_REQUESTS) })
	if (captures.size > MAX_CONVERSATIONS) {
		const oldest = captures.keys().next().value
		if (oldest) captures.delete(oldest)
	}
}

export function inspectContextRequests(sessionId: string): ContextInspection {
	const capture = captures.get(sessionId)
	return { requests: capture?.requests ?? [], omittedRequests: capture ? capture.sequence - capture.requests.length : 0 }
}

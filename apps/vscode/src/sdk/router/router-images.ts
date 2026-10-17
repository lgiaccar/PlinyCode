/**
 * Images on FreeAuto and BalanceAuto (`plinycode.router.images`).
 *
 * No free Pliny model accepts image input; a few hosted ones do. When a
 * routed call carries images (pasted into the prompt, or returned by a tool
 * such as `view_image` or `read_files`) and the candidate cannot see them,
 * the router sends it a copy of the request in which every image is replaced
 * by text. What text depends on the setting:
 *
 * - `describe` (default): each image is described once by the cheapest
 *   image-capable model the conversation may use (a free one if the catalog
 *   ever has one), and the description stands in for it as
 *   `<image_description sha="…">…</image_description>`. Descriptions are kept
 *   per conversation by the image's hash, so a re-sent history is not
 *   described again.
 * - `vision-model`: a call whose turn brought a new image runs on that
 *   image-capable model itself, image included. Later turns are routed as
 *   usual and see earlier images as descriptions.
 * - `off`: the image is replaced by a note saying one was attached but not shown.
 *
 * A candidate that accepts images always gets the request untouched.
 *
 * Paid models: unless the conversation runs on BalanceAuto or the user has
 * unlocked paid models, only free models may describe or take the call; with
 * none available both paid modes fall back to `off` and say so. Every paid
 * description is checked against the conversation's budget first, like an
 * advisor call, and its cost is reported so it lands in the task header and
 * the history record (`subagent_usage` rows with source `vision`).
 *
 * The stored conversation is never changed: only the request a text-only
 * model receives.
 */

import { createHash } from "node:crypto"
import { isPlinySelfHostedModelId, type ModelInfo, plinyThinkingControls } from "@plinycode/llms"
import type { AgentMessage, AgentMessagePart, AgentModel, AgentModelRequest } from "@plinycode/shared"
import { collectModelReply, hasKnownPrice, type ModelCallUsage, resolveCallUsage } from "../one-shot-model-call"
import type { RouterImagePlan } from "./router-types"
import { latestUserRequest } from "./unfinished-turn-guard"

const ROUTER_IMAGE_MODES = ["describe", "vision-model", "off"] as const

/** `plinycode.router.images`; see the comment at the top of this file. */
export type RouterImageMode = (typeof ROUTER_IMAGE_MODES)[number]

/** Anything unusable reads as the default. */
export function normalizeRouterImageMode(value: unknown): RouterImageMode {
	return (ROUTER_IMAGE_MODES as readonly unknown[]).includes(value) ? (value as RouterImageMode) : "describe"
}

/** Room for a careful transcription of a busy screenshot, not for an essay. */
const DESCRIPTION_MAX_OUTPUT_TOKENS = 1_200
const DESCRIPTION_TIMEOUT_MS = 60_000
const USER_REQUEST_MAX_CHARS = 1_000
/** New images described for one call; any beyond are replaced by a note. */
const MAX_DESCRIPTIONS_PER_CALL = 8
/** Conversations whose descriptions are kept; oldest dropped first. */
const MAX_TRACKED_CONVERSATIONS = 200
/** What a description is assumed to use when the describer is chosen by price: one image in, a few hundred words out. */
const PRICE_PROBE = { inputTokens: 1_600, outputTokens: 400 }

const DESCRIBE_INSTRUCTIONS = `You describe images for an AI coding assistant that cannot see them. Your description replaces the image in the assistant's conversation, so it must carry everything in the image the assistant could need.

Describe faithfully and completely:
- Transcribe all visible text verbatim: UI labels, menu items, error and warning messages, dialog text, code, terminal output, log lines, stack traces, file names, numbers.
- For a screenshot of an application: what application or page it is, the layout (which panel is where), what is selected, highlighted, disabled, or shows an error state.
- For a diagram: every box or node with its label, every arrow or edge with its direction and label, grouping, and the overall structure.
- For a chart: its type, axes, series, legend and the values that can be read.
- For code: reproduce it exactly, keeping indentation, inside a fenced code block.

Do not speculate about anything that is not visible, do not guess at text you cannot read (say it is unreadable), do not give advice and do not try to solve the user's problem. Plain text, no preamble.`

/** The image of an image part, or the base64 data of an image block inside a tool result. */
type ImageSource = string | Uint8Array | ArrayBuffer | URL

/** One distinct image in a request. */
interface RequestImage {
	/** First 12 hex digits of the SHA-256 of the image's bytes. */
	sha: string
	image: ImageSource
	mediaType?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** An image content block as tools return it: `{ type: "image", data, mediaType }`. */
function isToolResultImageBlock(value: unknown): value is { type: "image"; data: string; mediaType?: string } {
	return isRecord(value) && value.type === "image" && typeof value.data === "string"
}

function imageBytes(image: ImageSource): Buffer {
	if (typeof image === "string") {
		const comma = image.startsWith("data:") ? image.indexOf(",") : -1
		return Buffer.from(comma >= 0 ? image.slice(comma + 1) : image, "base64")
	}
	if (image instanceof URL) {
		return Buffer.from(image.href, "utf8")
	}
	return Buffer.from(image instanceof ArrayBuffer ? new Uint8Array(image) : image)
}

function imageSha(image: ImageSource): string {
	return createHash("sha256").update(imageBytes(image)).digest("hex").slice(0, 12)
}

/** Every image block nested in a tool result's output. */
function collectToolResultImages(value: unknown, found: RequestImage[]): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectToolResultImages(item, found)
		}
		return
	}
	if (!isRecord(value)) {
		return
	}
	if (isToolResultImageBlock(value)) {
		found.push({
			sha: imageSha(value.data),
			image: value.data,
			...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
		})
		return
	}
	for (const nested of Object.values(value)) {
		collectToolResultImages(nested, found)
	}
}

/** The distinct images of a request, in order: image parts and the image blocks of tool results. */
function findRequestImages(request: AgentModelRequest): RequestImage[] {
	const found: RequestImage[] = []
	for (const message of request.messages) {
		for (const part of message.content) {
			if (part.type === "image") {
				found.push({
					sha: imageSha(part.image),
					image: part.image,
					...(part.mediaType ? { mediaType: part.mediaType } : {}),
				})
			} else if (part.type === "tool-result") {
				collectToolResultImages(part.output, found)
			}
		}
	}
	const seen = new Set<string>()
	return found.filter((image) => !seen.has(image.sha) && seen.add(image.sha))
}

/** Whether a request carries an image anywhere a model would receive one. */
export function requestHasImages(request: AgentModelRequest): boolean {
	return request.messages.some((message) =>
		message.content.some(
			(part) => part.type === "image" || (part.type === "tool-result" && containsToolResultImage(part.output)),
		),
	)
}

function containsToolResultImage(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(containsToolResultImage)
	}
	if (!isRecord(value)) {
		return false
	}
	return isToolResultImageBlock(value) || Object.values(value).some(containsToolResultImage)
}

function replaceInToolOutput(value: unknown, textFor: (sha: string) => string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => replaceInToolOutput(item, textFor))
	}
	if (!isRecord(value)) {
		return value
	}
	if (isToolResultImageBlock(value)) {
		return { type: "text", text: textFor(imageSha(value.data)) }
	}
	return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, replaceInToolOutput(nested, textFor)]))
}

/** A copy of the request with every image replaced by `textFor(its sha)`; the original is not touched. */
function replaceRequestImages(request: AgentModelRequest, textFor: (sha: string) => string): AgentModelRequest {
	const messages = request.messages.map((message): AgentMessage => {
		let changed = false
		const content = message.content.map((part): AgentMessagePart => {
			if (part.type === "image") {
				changed = true
				return { type: "text", text: textFor(imageSha(part.image)) }
			}
			if (part.type === "tool-result" && containsToolResultImage(part.output)) {
				changed = true
				return { ...part, output: replaceInToolOutput(part.output, textFor) }
			}
			return part
		})
		return changed ? { ...message, content } : message
	})
	return { ...request, messages }
}

function descriptionText(sha: string, description: string): string {
	return `<image_description sha="${sha}">\n${description}\n</image_description>`
}

function omittedText(reason: string): string {
	return `[An image was attached here but is not shown to you: ${reason}. Do not guess what it shows; if you need it, ask the user to describe it.]`
}

/** USD a typical description would cost on a model; free models cost nothing. */
function probeCost(modelId: string, info: ModelInfo): number {
	if (isPlinySelfHostedModelId(modelId)) {
		return 0
	}
	return (
		(PRICE_PROBE.inputTokens * (info.pricing?.input ?? 0) + PRICE_PROBE.outputTokens * (info.pricing?.output ?? 0)) /
		1_000_000
	)
}

/**
 * The image-capable catalog models a conversation may use, cheapest first:
 * free ones, then paid ones with a known price when `allowPaid`. Router ids
 * are left out (BalanceAuto declares images but is not a model).
 */
function visionModelCandidates(knownModels: Record<string, ModelInfo> | undefined, allowPaid: boolean): string[] {
	return Object.entries(knownModels ?? {})
		.filter(([id, info]) => {
			if (!info?.capabilities?.includes("images") || info.metadata?.router === true) {
				return false
			}
			if (isPlinySelfHostedModelId(id)) {
				return true
			}
			return allowPaid && hasKnownPrice(id, info)
		})
		.map(([id, info]) => ({ id, cost: probeCost(id, info) }))
		.sort((left, right) => left.cost - right.cost || left.id.localeCompare(right.id))
		.map((entry) => entry.id)
}

/** The tool-free request that asks `modelId` to describe one image. */
function buildDescriptionRequest(image: RequestImage, userRequest: string, modelId: string): AgentModelRequest {
	const context = userRequest.trim()
		? `For context only, the user's message to the assistant was:\n${userRequest.slice(0, USER_REQUEST_MAX_CHARS)}\n\n`
		: ""
	return {
		systemPrompt: DESCRIBE_INSTRUCTIONS,
		messages: [
			{
				id: `image-description-${image.sha}`,
				role: "user",
				content: [
					{ type: "text", text: `${context}Describe this image.` },
					{ type: "image", image: image.image, ...(image.mediaType ? { mediaType: image.mediaType } : {}) },
				],
				createdAt: Date.now(),
			},
		],
		tools: [],
		options: {
			maxTokens: DESCRIPTION_MAX_OUTPUT_TOKENS,
			// Like the advisor: a reasoning switch only where one was measured.
			...(plinyThinkingControls(modelId) ? { thinking: false } : {}),
		},
	}
}

/** What the router keeps per conversation about its images. */
interface ImageConversation {
	/** Root turns started in this conversation; images first seen in the current one are new. */
	turn: number
	firstSeenTurn: Map<string, number>
	descriptions: Map<string, string>
	/** Descriptions under way, so two calls never pay for the same image. */
	pending: Map<string, Promise<void>>
	/** Images that failed to be described, by turn: not retried within the turn. */
	failedInTurn: Map<string, number>
	/** Notices already shown (keys from `noticeKey`). */
	notices: Set<string>
}

const conversations = new Map<string, ImageConversation>()

function imageConversation(key: string): ImageConversation {
	let conversation = conversations.get(key)
	if (conversation) {
		// Most recently used last, so the oldest is dropped first.
		conversations.delete(key)
	} else {
		conversation = {
			turn: 0,
			firstSeenTurn: new Map(),
			descriptions: new Map(),
			pending: new Map(),
			failedInTurn: new Map(),
			notices: new Set(),
		}
	}
	conversations.set(key, conversation)
	if (conversations.size > MAX_TRACKED_CONVERSATIONS) {
		const oldest = conversations.keys().next().value
		if (oldest !== undefined) {
			conversations.delete(oldest)
		}
	}
	return conversation
}

/** A new root turn: images seen from now on are this turn's. */
export function beginImageTurn(conversationKey: string): void {
	imageConversation(conversationKey).turn += 1
}

/** Why an image was not shown, or what happened to it, for the host's chat rows. */
export type RouterImageNotice =
	| { kind: "described"; modelId: string; count: number; cost: number }
	| { kind: "vision-model"; modelId: string }
	| { kind: "off" }
	| { kind: "paid-locked"; mode: "describe" | "vision-model" }
	| { kind: "budget"; reason: string }
	| { kind: "failed"; modelId: string; error: string }

/** Notices shown once per conversation; the others once per turn. */
const ONCE_PER_CONVERSATION = new Set<RouterImageNotice["kind"]>(["described", "off", "paid-locked"])

interface RouterImageHandlerDeps {
	/** Key of the conversation's image state: the router's session key. */
	conversationKey: () => string
	mode: () => RouterImageMode
	/** Whether the conversation may spend money on images: BalanceAuto, or paid models unlocked. */
	paidAllowed: () => boolean
	knownModels: () => Record<string, ModelInfo> | undefined
	/** A gateway model on the session's connection. */
	createModel: (modelId: string) => AgentModel | undefined
	/** The conversation's budget, checked before paid work; returns why it may not be spent, or undefined. */
	checkBudget?: () => Promise<string | undefined>
	/** Each billed description, after the call. */
	onUsage?: (info: { modelId: string; sha: string; usage: ModelCallUsage }) => void
	onNotice?: (notice: RouterImageNotice) => void
	timeoutMs?: number
}

/**
 * The router's image handling for one session. `plan` is called for a routed
 * call that carries images and says how to route it and what a text-only
 * candidate is sent instead; undefined when the request has no images after all.
 */
export function createRouterImageHandler(deps: RouterImageHandlerDeps): {
	plan: (request: AgentModelRequest) => Promise<RouterImagePlan | undefined>
} {
	const timeoutMs = deps.timeoutMs ?? DESCRIPTION_TIMEOUT_MS

	const notify = (conversation: ImageConversation, notice: RouterImageNotice): void => {
		const key = ONCE_PER_CONVERSATION.has(notice.kind) ? notice.kind : `${notice.kind}:${conversation.turn}`
		if (conversation.notices.has(key)) {
			return
		}
		conversation.notices.add(key)
		deps.onNotice?.(notice)
	}

	/** Describe one image into the conversation's cache; failures are remembered for the turn. */
	const describe = async (
		conversation: ImageConversation,
		image: RequestImage,
		modelId: string,
		userRequest: string,
		signal: AbortSignal | undefined,
		described: { count: number; cost: number },
	): Promise<void> => {
		const model = deps.createModel(modelId)
		if (!model) {
			conversation.failedInTurn.set(image.sha, conversation.turn)
			return
		}
		const request = buildDescriptionRequest(image, userRequest, modelId)
		const reply = await collectModelReply({
			model,
			request,
			timeoutMs,
			parentSignal: signal,
			failureText: "the description call failed",
		})
		const usage = resolveCallUsage(reply, request, modelId, deps.knownModels()?.[modelId])
		if (usage) {
			deps.onUsage?.({ modelId, sha: image.sha, usage })
			described.cost += usage.totalCost
		}
		const text = reply.text.trim()
		if (reply.error || !text) {
			conversation.failedInTurn.set(image.sha, conversation.turn)
			if (reply.error !== "cancelled") {
				notify(conversation, { kind: "failed", modelId, error: reply.error ?? "the description was empty" })
			}
			return
		}
		conversation.descriptions.set(
			image.sha,
			reply.finishReason === "max-tokens" ? `${text}\n[The description was cut off at its length limit.]` : text,
		)
		described.count += 1
	}

	/**
	 * The request for a model that cannot see images. Never rejects. Without
	 * `omitReason` the images are described; with it each image is replaced by
	 * a note giving that reason (descriptions already made are still used).
	 */
	const textOnlyRequest = async (
		request: AgentModelRequest,
		images: RequestImage[],
		conversation: ImageConversation,
		omitReason?: string,
	): Promise<AgentModelRequest> => {
		const reasons = new Map<string, string>()
		if (omitReason !== undefined) {
			return replaceRequestImages(request, (sha) => {
				const description = conversation.descriptions.get(sha)
				return description !== undefined ? descriptionText(sha, description) : omittedText(omitReason)
			})
		}

		const describer = visionModelCandidates(deps.knownModels(), deps.paidAllowed())[0]
		const waiting = images.filter((image) => !conversation.descriptions.has(image.sha))
		const pendingElsewhere = waiting.filter((image) => conversation.pending.has(image.sha))
		const toDescribe = waiting.filter(
			(image) => !conversation.pending.has(image.sha) && conversation.failedInTurn.get(image.sha) !== conversation.turn,
		)
		for (const image of waiting) {
			if (conversation.failedInTurn.get(image.sha) === conversation.turn) {
				reasons.set(image.sha, "it could not be described")
			}
		}

		let refusal: string | undefined
		if (toDescribe.length > 0 && !describer) {
			refusal = "no model that can see images is available, because paid models are locked"
			notify(conversation, { kind: "paid-locked", mode: "describe" })
		} else if (toDescribe.length > 0 && describer && !isPlinySelfHostedModelId(describer)) {
			const overBudget = await deps.checkBudget?.()
			if (overBudget) {
				refusal = "describing it would exceed this conversation's budget"
				notify(conversation, { kind: "budget", reason: overBudget })
			}
		}

		if (refusal) {
			for (const image of toDescribe) {
				reasons.set(image.sha, refusal)
			}
		} else if (describer && toDescribe.length > 0) {
			const batch = toDescribe.slice(0, MAX_DESCRIPTIONS_PER_CALL)
			for (const image of toDescribe.slice(MAX_DESCRIPTIONS_PER_CALL)) {
				reasons.set(image.sha, `only ${MAX_DESCRIPTIONS_PER_CALL} new images are described per request`)
			}
			const userRequest = latestUserRequest(request.messages)
			const described = { count: 0, cost: 0 }
			await Promise.all(
				batch.map((image) => {
					const work = describe(conversation, image, describer, userRequest, request.signal, described).finally(() =>
						conversation.pending.delete(image.sha),
					)
					conversation.pending.set(image.sha, work)
					return work
				}),
			)
			if (described.count > 0) {
				notify(conversation, { kind: "described", modelId: describer, count: described.count, cost: described.cost })
			}
		}
		// Another call is describing these already: wait for it rather than pay twice.
		await Promise.all(pendingElsewhere.map((image) => conversation.pending.get(image.sha)))

		return replaceRequestImages(request, (sha) => {
			const description = conversation.descriptions.get(sha)
			if (description !== undefined) {
				return descriptionText(sha, description)
			}
			return omittedText(reasons.get(sha) ?? "it could not be described")
		})
	}

	return {
		async plan(request) {
			const images = findRequestImages(request)
			if (images.length === 0) {
				return undefined
			}
			const conversation = imageConversation(deps.conversationKey())
			for (const image of images) {
				if (!conversation.firstSeenTurn.has(image.sha)) {
					conversation.firstSeenTurn.set(image.sha, conversation.turn)
				}
			}
			const mode = deps.mode()
			// Set when the images are replaced by a note rather than described.
			let omitReason: string | undefined
			let leadCandidates: string[] | undefined

			const hasNewImage = images.some((image) => conversation.firstSeenTurn.get(image.sha) === conversation.turn)
			if (mode === "off") {
				omitReason = "image input to this model is turned off (plinycode.router.images)"
			} else if (mode === "vision-model" && hasNewImage) {
				const visionModels = visionModelCandidates(deps.knownModels(), deps.paidAllowed())
				const lead = visionModels[0]
				if (!lead) {
					notify(conversation, { kind: "paid-locked", mode: "vision-model" })
					omitReason = "no model that can see images is available, because paid models are locked"
				} else {
					const overBudget = isPlinySelfHostedModelId(lead) ? undefined : await deps.checkBudget?.()
					if (overBudget) {
						notify(conversation, { kind: "budget", reason: overBudget })
						omitReason = "showing it to a model that can see images would exceed this conversation's budget"
					} else {
						leadCandidates = visionModels
						notify(conversation, { kind: "vision-model", modelId: lead })
					}
				}
			}

			let textOnly: Promise<AgentModelRequest> | undefined
			return {
				...(leadCandidates ? { leadCandidates } : {}),
				textOnlyRequest: () => {
					if (!textOnly) {
						if (mode === "off") {
							notify(conversation, { kind: "off" })
						}
						textOnly = textOnlyRequest(request, images, conversation, omitReason).catch(
							// Building a gateway model can throw; the call still goes ahead, without the images.
							() =>
								replaceRequestImages(request, (sha) => {
									const description = conversation.descriptions.get(sha)
									return description !== undefined
										? descriptionText(sha, description)
										: omittedText("it could not be described")
								}),
						)
					}
					return textOnly
				},
			}
		},
	}
}

/**
 * The `AgentModel` that makes FreeAuto work.
 *
 * Every call it receives is routed to a concrete free Pliny model chosen by the
 * policy, and delegated to the model the SDK would otherwise have built. When a
 * delegate misbehaves *before producing any output*, the next candidate takes
 * over silently — the consumer never learns the first attempt happened.
 *
 * The rule that shapes everything here: **once content has been forwarded, we
 * can no longer switch models inside the call**. Those deltas are already on
 * screen and there is no event that retracts them, so a second attempt would
 * duplicate text. A post-content failure is therefore reported as a normal
 * `finish{reason:"error"}` and recovery is left to the run-level hook, which
 * continues from the persisted partial rather than replaying it.
 *
 * For the same reason this never rethrows after content: a thrown error would
 * escape the agent loop before the partial assistant message is built, losing
 * it from the transcript and guaranteeing duplication on the retry.
 */

import { classifyProviderError, type ModelInfo, type PlinyThinkingControls } from "@plinycode/llms"
import type { AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { Logger } from "@/shared/services/Logger"
import { effortOptions, selectCandidates } from "./router-policy"
import type {
	RouterCallTiming,
	RouterClassification,
	RouterDecision,
	RouterEffort,
	RouterRequestFeatures,
	RouterRules,
} from "./router-types"

/** What the router reports back to the host so it can show rows and keep state. */
export interface RouterObserver {
	/** A call is about to start on `modelId`; `effort` is set when the router changed its reasoning. */
	onCallStart(info: { modelId: string; decision: RouterDecision; features: RouterRequestFeatures; effort?: RouterEffort }): void
	/** A candidate failed before producing output; `nextModelId` takes over. */
	onFailover(info: {
		modelId: string
		nextModelId: string | undefined
		error: string
		benched: boolean
		timing: RouterCallTiming
	}): void
	/** A call produced output and finished without a routing-level error. */
	onCallSuccess(info: { modelId: string; timing: RouterCallTiming }): void
	/** A call failed after producing output; the run-level hook decides next. */
	onCallError(info: { modelId: string; error: string; timing: RouterCallTiming }): void
}

export interface RoutedAgentModelDeps {
	rules: () => RouterRules
	features: (request: AgentModelRequest) => RouterRequestFeatures
	knownModels: () => Record<string, ModelInfo> | undefined
	isHealthy: (modelId: string) => boolean
	createDelegate: (modelId: string) => AgentModel
	observer: RouterObserver
	/** Measured reasoning switches per model; models without one keep their default. */
	thinkingControls?: (modelId: string) => PlinyThinkingControls | undefined
	/** Classifier verdict for the call, when the host runs one. Never throws. */
	classify?: (
		request: AgentModelRequest,
		features: RouterRequestFeatures,
		rules: RouterRules,
	) => Promise<RouterClassification | undefined>
	/** Injectable for tests. */
	now?: () => number
}

/** Event types that mean the model actually produced something. */
function isContentEvent(event: AgentModelEvent): boolean {
	return (
		event.type === "text-delta" ||
		event.type === "media" ||
		event.type === "reasoning-delta" ||
		event.type === "tool-call-delta" ||
		event.type === "tool-result"
	)
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}
	return typeof error === "string" ? error : String(error)
}

/**
 * True for failures that swapping models cannot fix. Auth is a credential
 * problem every model shares; an abort is the user's decision.
 */
function isNonRoutableFailure(error: unknown, aborted: boolean): boolean {
	if (aborted) {
		return true
	}
	return classifyProviderError(error) === "auth"
}

/**
 * Wrap an async iterable so that a gap longer than `timeoutMs` between events
 * aborts it. Pliny's own request timeout is 5 minutes and only fires for the
 * whole request, which is far too coarse for a stream that has gone quiet.
 */
async function* withStallWatchdog(
	source: AsyncIterable<AgentModelEvent>,
	options: { firstTokenTimeoutMs: number; stallTimeoutMs: number; onStall: (ms: number) => void },
): AsyncGenerator<AgentModelEvent> {
	const iterator = source[Symbol.asyncIterator]()
	let sawEvent = false
	// A stalled delegate is, by definition, stuck: its generator is parked on an
	// await that may never settle, so `return()` on it can hang forever too.
	// Abandon it instead of awaiting the cleanup — the underlying request is
	// cancelled by the caller's abort signal.
	const abandon = () => {
		void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined)
	}
	let stalledOut = false
	try {
		for (;;) {
			const budget = sawEvent ? options.stallTimeoutMs : options.firstTokenTimeoutMs
			let timer: ReturnType<typeof setTimeout> | undefined
			const stalled = new Promise<"stalled">((resolve) => {
				timer = setTimeout(() => resolve("stalled"), budget)
			})
			let settled: IteratorResult<AgentModelEvent> | "stalled"
			try {
				settled = await Promise.race([iterator.next(), stalled])
			} finally {
				if (timer) {
					clearTimeout(timer)
				}
			}
			if (settled === "stalled") {
				stalledOut = true
				options.onStall(budget)
				abandon()
				throw new Error(
					sawEvent
						? `Stream stalled: no output for ${Math.round(budget / 1000)}s`
						: `Stream produced no output within ${Math.round(budget / 1000)}s`,
				)
			}
			if (settled.done) {
				return
			}
			sawEvent = true
			yield settled.value
		}
	} finally {
		if (!stalledOut) {
			abandon()
		}
	}
}

/**
 * Build the FreeAuto `AgentModel`.
 *
 * Delegates are cached per model id for the lifetime of the returned model, so
 * a turn that keeps choosing the same model does not rebuild its gateway.
 */
export function createRoutedAgentModel(deps: RoutedAgentModelDeps): AgentModel {
	const now = deps.now ?? (() => Date.now())
	const delegates = new Map<string, AgentModel>()

	const delegateFor = (modelId: string): AgentModel => {
		let delegate = delegates.get(modelId)
		if (!delegate) {
			delegate = deps.createDelegate(modelId)
			delegates.set(modelId, delegate)
		}
		return delegate
	}

	return {
		async *stream(request: AgentModelRequest): AsyncGenerator<AgentModelEvent> {
			const rules = deps.rules()
			const features = deps.features(request)
			const classification = features.hasImages ? undefined : await deps.classify?.(request, features, rules)
			const decision = selectCandidates({
				rules,
				features,
				knownModels: deps.knownModels(),
				isHealthy: deps.isHealthy,
				classification,
			})

			const candidates = decision.candidates
			if (candidates.length === 0) {
				yield {
					type: "finish",
					reason: "error",
					error:
						features.hasImages && decision.excludedNoImages.length > 0
							? "FreeAuto routes only to free Pliny models, none of which accept images. " +
								"Pick a vision-capable model or remove the image."
							: "FreeAuto has no free Pliny models available to route to.",
					errorRetryable: false,
				}
				return
			}

			let lastError = "FreeAuto exhausted every candidate model."

			for (let index = 0; index < candidates.length; index += 1) {
				const modelId = candidates[index]
				const nextModelId = candidates[index + 1]
				const startedAt = now()
				const reasoning = effortOptions(decision.effort, decision.reasoningEffort, deps.thinkingControls?.(modelId))
				const delegateRequest = reasoning ? { ...request, options: { ...request.options, ...reasoning } } : request
				deps.observer.onCallStart({
					modelId,
					decision,
					features,
					...(reasoning && decision.effort ? { effort: decision.effort } : {}),
				})

				let producedContent = false
				let firstContentAt: number | undefined
				let finished = false
				let failure: { error: string; raw: unknown } | undefined
				const timing = (): RouterCallTiming => ({
					startedAt,
					...(firstContentAt !== undefined ? { firstContentAt } : {}),
					endedAt: now(),
				})

				try {
					const delegate = delegateFor(modelId)
					const source = await delegate.stream(delegateRequest)
					const guarded = withStallWatchdog(source, {
						firstTokenTimeoutMs: rules.health.firstTokenTimeoutMs,
						stallTimeoutMs: rules.health.stallTimeoutMs,
						onStall: (ms) => Logger.warn(`[FreeAuto] ${modelId} stalled after ${ms}ms (call started ${startedAt})`),
					})

					for await (const event of guarded) {
						if (event.type === "finish") {
							finished = true
							if (event.reason === "error") {
								failure = { error: event.error ?? "Model stream failed", raw: event.error }
								// Do not forward a failing finish yet: if nothing was
								// produced we can still switch models invisibly.
								if (producedContent) {
									yield event
								}
								break
							}
							// A turn that finishes cleanly having produced nothing is
							// the "empty response" failure mode; treat it as a failure
							// so another model gets a chance.
							if (!producedContent && event.reason === "stop") {
								failure = {
									error: "Model returned an empty response",
									raw: undefined,
								}
								break
							}
							yield event
							break
						}
						if (isContentEvent(event) && !producedContent) {
							producedContent = true
							firstContentAt = now()
						}
						yield event
					}

					// A stream that ended without any finish event looks like a clean
					// stop to the agent loop, which would silently accept a truncated
					// answer. Name it instead.
					if (!finished && !failure) {
						if (producedContent) {
							yield {
								type: "finish",
								reason: "error",
								error: `Response stream from ${modelId} ended without a finish reason`,
								errorRetryable: true,
							}
							deps.observer.onCallError({
								modelId,
								error: "Response stream ended without a finish reason",
								timing: timing(),
							})
							return
						}
						failure = {
							error: `Response stream from ${modelId} ended without a finish reason`,
							raw: undefined,
						}
					}
				} catch (error) {
					const aborted = request.signal?.aborted === true
					if (aborted) {
						// The user cancelled. Report it as an abort and stop; never
						// retry, never bench the model.
						yield { type: "finish", reason: "aborted" }
						return
					}
					failure = { error: errorText(error), raw: error }

					if (producedContent) {
						// Cannot re-stream: convert to a finish so the agent loop keeps
						// the partial message it has already assembled, and let the
						// run-level hook continue with another model.
						yield {
							type: "finish",
							reason: "error",
							error: failure.error,
							errorClass: classifyProviderError(error),
							errorRetryable: true,
						}
						deps.observer.onCallError({ modelId, error: failure.error, timing: timing() })
						return
					}
				}

				if (!failure) {
					deps.observer.onCallSuccess({ modelId, timing: timing() })
					return
				}

				lastError = failure.error

				if (producedContent) {
					// Already forwarded the failing finish above.
					deps.observer.onCallError({ modelId, error: failure.error, timing: timing() })
					return
				}

				if (isNonRoutableFailure(failure.raw, request.signal?.aborted === true)) {
					// Auth failures are identical on every model; forward unchanged.
					yield {
						type: "finish",
						reason: "error",
						error: failure.error,
						errorClass: classifyProviderError(failure.raw),
						errorRetryable: false,
					}
					deps.observer.onCallError({ modelId, error: failure.error, timing: timing() })
					return
				}

				Logger.warn(`[FreeAuto] ${modelId} failed before producing output: ${failure.error}`)
				deps.observer.onFailover({
					modelId,
					nextModelId,
					error: failure.error,
					benched: false,
					timing: timing(),
				})
			}

			// Every candidate failed without producing anything. Report it as a
			// non-retryable error: the agent loop's own retry would only re-run the
			// same exhausted rotation.
			yield {
				type: "finish",
				reason: "error",
				error: `FreeAuto could not complete the request. Last error: ${lastError}`,
				errorRetryable: false,
			}
		},
	}
}

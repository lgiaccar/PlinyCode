// Error reshaping for the webview's ErrorRow. Split out of
// message-translator.ts (see message-translator/index.ts).

import type { ProviderErrorClass } from "@plinycode/shared"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { describeCredentialRejectedError, describeMissingCredentialError } from "../provider-credential-error"

const MODEL_NOT_FOUND_GUIDANCE =
	"This model may be retired or unavailable on your account. Switch to a different model in API Configuration settings, then retry."

const VERTEX_GLOBAL_REGION_GUIDANCE =
	'This model does not support the Vertex AI global endpoint. Switch Google Cloud Region from "global" to a specific region (e.g. "us-east5") in API Configuration settings, or choose a different model, then retry.'

/**
 * Rewrite a model-not-found error into actionable guidance, or undefined if the
 * message is not one. The provider's HTTP status is stripped upstream, so this
 * matches on text rather than a status code.
 */
function describeModelNotFoundError(rawMessage: string): string | undefined {
	// Anthropic's 404 body collapses to a bare "model: <id>" label.
	const bareModelLabel = rawMessage.match(/^\s*model:\s*(\S+)\s*$/i)
	if (bareModelLabel) {
		return `Model "${bareModelLabel[1]}" was not found. ${MODEL_NOT_FOUND_GUIDANCE}`
	}

	// Keep the not-found signal in the same clause as "model" so errors that
	// merely mention one (plan gating, deprecated features) are left untouched.
	const modelNotFound = /\bmodel\b[^.,;:]*\b(not[ _]?found|does not exist|no such model|unknown model)\b/i
	if (modelNotFound.test(rawMessage)) {
		return `${rawMessage} ${MODEL_NOT_FOUND_GUIDANCE}`
	}

	return undefined
}

/**
 * Rewrite a Vertex "model not available on the global endpoint" rejection into
 * recovery guidance, or undefined for anything else. The picker intentionally
 * no longer filters the catalog by endpoint capability — endpoint support
 * changes faster than any host-maintained allowlist — so an unsupported pick
 * under `vertexRegion: "global"` surfaces here, loud and actionable, instead
 * of hiding models from the picker.
 *
 * Observed shapes: AnthropicVertex's bare `model not available in region:
 * global`, and Google's `Publisher Model `projects/.../locations/global/...`
 * was not found / no access` body. The HTTP status is stripped upstream, so
 * this matches on text.
 */
function describeVertexGlobalRegionError(rawMessage: string, providerId?: string): string | undefined {
	if (providerId !== "vertex") {
		return undefined
	}
	const rejectedFromGlobalRegion =
		/not (?:available|supported|found) in (?:region|location)\b[^.\n]*\bglobal\b/i.test(rawMessage) ||
		/\bregion:\s*global\b/i.test(rawMessage) ||
		(/\blocations\/global\b/.test(rawMessage) && /not found|does not have access|permission denied/i.test(rawMessage))
	if (!rejectedFromGlobalRegion) {
		return undefined
	}
	return `${rawMessage} ${VERTEX_GLOBAL_REGION_GUIDANCE}`
}

/**
 * Reshape an SDK error into the serialized ClineError JSON the webview's
 * ErrorRow expects (`code`, `providerId`, `details`), extracting structured
 * info from the error message when present and falling back to raw text.
 */
export function reshapeErrorForWebview(
	error: { message?: string; status?: number; code?: string },
	providerId?: string,
	modelId?: string,
	errorClass?: ProviderErrorClass,
): string {
	// The ClineError-JSON branches below are cline-provider flows (balance,
	// spend limit), so "cline" stays their fallback id. The missing-credential
	// message instead gets the raw value: defaulting there would name the wrong
	// provider when the active provider id is unknown.
	const clineErrorProviderId = providerId ?? "cline"
	const rawMessage = error.message ?? "Unknown error"

	// Vertex global-endpoint rejections get recovery guidance before the
	// generic model-not-found rewrite can claim them (Google's Publisher
	// Model "was not found" body also matches the not-found pattern).
	const vertexGlobalRegionMessage = describeVertexGlobalRegionError(rawMessage, providerId)
	if (vertexGlobalRegionMessage) {
		return vertexGlobalRegionMessage
	}

	// A BYOK provider rejected the configured credentials (llms classified the
	// HTTP 401/403 while the typed error was still available). Raw provider
	// bodies here are dead ends — e.g. Mistral's `{"detail":"Invalid API Key"}`
	// is identical for a wrong, empty, or wrong-scope key — so point the user
	// at the key configuration instead. Cline-account providers keep the JSON
	// path below (the webview renders their auth failures as a sign-in card),
	// and so does an *unknown* provider id: rewriting without knowing the
	// provider could suppress that sign-in card for a cline-account failure.
	if (errorClass === "auth" && providerId !== undefined && !isClineManagedProvider(providerId)) {
		return describeCredentialRejectedError(rawMessage, providerId)
	}

	// Try to extract structured error info from the error message.
	// The SDK often wraps API error JSON in the Error.message field.
	let parsed: Record<string, unknown> | undefined
	try {
		parsed = JSON.parse(rawMessage)
	} catch {
		// Not JSON — try to find JSON embedded in the message
		// (e.g. "Error: {\"code\":\"insufficient_credits\",...}")
		const jsonMatch = rawMessage.match(/\{[\s\S]*"code"[\s\S]*\}/)
		if (jsonMatch) {
			try {
				parsed = JSON.parse(jsonMatch[0])
			} catch {
				// ignore
			}
		}
	}

	if (!parsed) {
		// Plain-text error — the SDK sometimes strips structured API error JSON
		// and delivers only a human-readable string such as
		// "Not enough credits available" or "Your daily spend limit of $20.00
		// has been reached." Detect these by keyword and synthesize the
		// ClineError-compatible JSON the webview expects.
		const lower = rawMessage.toLowerCase()
		if (
			lower.includes("insufficient_credits") ||
			lower.includes("insufficient credits") ||
			lower.includes("insufficient balance") ||
			lower.includes("not enough credits") ||
			lower.includes("run out of credits") ||
			lower.includes("out of credits")
		) {
			// Extract balance from text like "balance is $-0.14" if present
			const balanceMatch = rawMessage.match(/\$(-?\d+(?:\.\d+)?)/)
			const balance = balanceMatch ? Number.parseFloat(balanceMatch[1]) : 0
			return JSON.stringify({
				message: rawMessage,
				code: "insufficient_credits",
				providerId: clineErrorProviderId,
				details: {
					current_balance: balance,
					message: rawMessage,
				},
			})
		}
		if (lower.includes("spend_limit_exceeded") || lower.includes("spend limit")) {
			return JSON.stringify({
				message: rawMessage,
				code: "SPEND_LIMIT_EXCEEDED",
				providerId: clineErrorProviderId,
				details: {
					code: "SPEND_LIMIT_EXCEEDED",
					message: rawMessage,
				},
			})
		}
		const credentialMessage = describeMissingCredentialError(rawMessage, providerId)
		if (credentialMessage) {
			return credentialMessage
		}
		const notFoundMessage = describeModelNotFoundError(rawMessage)
		if (notFoundMessage) {
			return notFoundMessage
		}
		return rawMessage
	}

	// Detect insufficient credits (402) — needs code + current_balance for
	// ClineError.getErrorType() to return ClineErrorType.Balance
	const code = (parsed.code as string) ?? error.code
	if (code === "insufficient_credits" && typeof parsed.current_balance === "number") {
		return JSON.stringify({
			message: (parsed.message as string) ?? rawMessage,
			code: "insufficient_credits",
			providerId: clineErrorProviderId,
			details: {
				current_balance: parsed.current_balance,
				total_spent: parsed.total_spent,
				total_promotions: parsed.total_promotions,
				message: (parsed.message as string) ?? "You have run out of credits.",
				buy_credits_url: parsed.buy_credits_url,
			},
		})
	}

	// Detect spend limit exceeded (429)
	if (code === "SPEND_LIMIT_EXCEEDED") {
		return JSON.stringify({
			message: (parsed.message as string) ?? rawMessage,
			code: "SPEND_LIMIT_EXCEEDED",
			providerId: clineErrorProviderId,
			details: {
				code: "SPEND_LIMIT_EXCEEDED",
				limit_scope: parsed.limit_scope,
				budget_period: parsed.budget_period,
				limit_usd: parsed.limit_usd,
				spent_usd: parsed.spent_usd,
				resets_at: parsed.resets_at,
				message: parsed.message,
			},
		})
	}

	// For other structured errors, pass through the parsed JSON so
	// ClineError.parse() can still extract what it can.
	return JSON.stringify(parsed)
}

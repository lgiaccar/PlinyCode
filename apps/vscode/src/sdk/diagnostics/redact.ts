/**
 * Redaction for the diagnostics bundle (docs/diagnostics-bundle.md): removes
 * what looks like a credential from settings, MCP configuration and text
 * before it is written to a folder the user is going to share.
 *
 * Two layers, both deliberately eager: a value whose key names a secret is
 * replaced whole, and secret-looking values inside any string are replaced
 * wherever they appear. A false positive hides a harmless setting; a false
 * negative leaks a token.
 */

const REDACTED = "[REDACTED]"

/** Keys whose every nested value is a secret (MCP server environments and request headers). */
const OPAQUE_KEYS = /(^|\.)(env|environment|headers)$/i

/**
 * Keys whose value is a secret: exact names, and anything ending in Key,
 * Token, Secret, Password, Authorization, Credential(s), Cookie, Nonce or
 * MachineId. Numbers and booleans under such a key are kept
 * (`planModeThinkingBudgetTokens` is a budget, not a token).
 */
const SECRET_KEY =
	/(api[-_]?key|access[-_]?key|secret|token|password|passwd|authorization|credential|cookie|nonce|bearer|machine[-_]?id)s?$|(^|\.)(auth|pat|x-api-key)$/i

/** Secret-looking values inside text, replaced wherever they appear. */
const WHOLE_VALUE_PATTERNS: RegExp[] = [
	// OpenAI-style keys and GitHub tokens
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	// AWS access key ids
	/\bAKIA[0-9A-Z]{16}\b/g,
	// JWTs
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]
/** Authorization headers: the scheme stays, the credential goes. */
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
/** `apiKey=…`, `token: …` and the like: the key and the separator stay, the value goes. */
const ASSIGNMENT_PATTERN =
	/\b(api[-_]?key|access[-_]?key|secret|token|password|passwd|authorization)(\s*[=:]\s*["']?)(?!Bearer\b|Basic\b|\[REDACTED\])[^\s"',;&]{4,}/gi

/** Replaces secret-looking values inside a string; other text is unchanged. */
export function redactText(text: string): string {
	let out = text.replace(AUTH_HEADER_PATTERN, `$1 ${REDACTED}`)
	for (const pattern of WHOLE_VALUE_PATTERNS) {
		out = out.replace(pattern, REDACTED)
	}
	return out.replace(ASSIGNMENT_PATTERN, `$1$2${REDACTED}`)
}

function isScalarNonSecret(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "number" || typeof value === "boolean"
}

/**
 * Deep-copies a JSON-like value with secrets removed: a value under a secret
 * key becomes `[REDACTED]` (an object under `env` or `headers` keeps its keys
 * and loses every value), and every remaining string goes through
 * `redactText`.
 */
export function redactValue(value: unknown, key?: string): unknown {
	if (key !== undefined && OPAQUE_KEYS.test(key)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((name) => [name, REDACTED]))
		}
		return isScalarNonSecret(value) ? value : REDACTED
	}
	if (key !== undefined && SECRET_KEY.test(key)) {
		return isScalarNonSecret(value) || value === "" ? value : REDACTED
	}
	if (typeof value === "string") {
		return redactText(value)
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item))
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactValue(item, name)]),
		)
	}
	return value
}

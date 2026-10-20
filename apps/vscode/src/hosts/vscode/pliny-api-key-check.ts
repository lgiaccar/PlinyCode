import { PLINY_BASE_URL, PLINY_DEFAULT_HEADERS } from "@plinycode/llms"
import { buildEffectiveProviderConfig } from "@/sdk/model-catalog/effective-config"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { requestPlinyBudget } from "@/sdk/pliny-budget"
import { createPlinyFetch } from "@/sdk/pliny-fetch"
import { loadRouterRules } from "@/sdk/router/router-rules-store"
import { Logger } from "@/shared/services/Logger"
import type { PlinyApiKeys } from "./pliny-api-keys"

/** A free model answering one token is quick; this leaves room for a cold start. */
const TEST_TIMEOUT_MS = 30_000

type KeyStore = Pick<PlinyApiKeys, "list" | "findByValue">

/** Why `name` cannot be given to a key (all keys but `exceptId` count), or undefined when it can. */
export function plinyKeyNameProblem(keys: Pick<PlinyApiKeys, "list">, name: string, exceptId?: string): string | undefined {
	const trimmed = name.trim()
	if (!trimmed) {
		return "Enter a nickname for the key."
	}
	const taken = keys.list().some((k) => k.id !== exceptId && k.name.toLowerCase() === trimmed.toLowerCase())
	return taken ? `Another key is already named "${trimmed}".` : undefined
}

/**
 * Why a key typed in Settings cannot be stored under `name`, or undefined when
 * it can: the name must be free, the key new, and the gateway must not reject
 * it. A gateway that cannot be asked (the network, a proxy) does not stop it.
 */
export async function plinyNewKeyProblem(
	keys: KeyStore,
	name: string,
	key: string,
	checkGateway: (key: string) => Promise<string | undefined> = gatewayRejection,
): Promise<string | undefined> {
	const nameProblem = plinyKeyNameProblem(keys, name)
	if (nameProblem) {
		return nameProblem
	}
	const trimmed = key.trim()
	if (!trimmed) {
		return "Paste the key."
	}
	const duplicate = await keys.findByValue(trimmed)
	if (duplicate) {
		return `This key is already stored as "${duplicate.name}".`
	}
	return checkGateway(trimmed)
}

/** Why the gateway's budget endpoint rejected `key`, or undefined when it accepted it or could not be asked. */
async function gatewayRejection(key: string): Promise<string | undefined> {
	try {
		const { status } = await requestPlinyBudget(key, buildEffectiveProviderConfig(parseProviderId("pliny")))
		if (status === 401 || status === 403) {
			return `The Pliny gateway rejected this key (HTTP ${status}). Check it and try again.`
		}
		return undefined
	} catch (error) {
		Logger.warn(
			`[PlinyApiKeys] Could not check the key against the gateway: ${error instanceof Error ? error.message : error}`,
		)
		return undefined
	}
}

interface PlinyKeyTestResult {
	ok: boolean
	/** The HTTP status, or 0 when the server could not be reached. */
	status: number
	message: string
	latencyMs: number
}

export interface PlinyKeyTestDeps {
	fetch: typeof globalThis.fetch
	/** The free model the request goes to. */
	modelId: () => Promise<string>
	now: () => number
}

const defaultTestDeps: PlinyKeyTestDeps = {
	fetch: createPlinyFetch(TEST_TIMEOUT_MS),
	// The free utility model Improve prompt uses: an instruct model, quick to answer.
	modelId: async () => (await loadRouterRules()).utility.commit,
	now: () => Date.now(),
}

/**
 * Sends a one-token chat completion with `key` to the Pliny inference server,
 * so the test covers what a conversation needs: the key, the network path and
 * a model answering. The model is a free one, so the test costs nothing.
 */
export async function testPlinyApiKey(key: string, deps: PlinyKeyTestDeps = defaultTestDeps): Promise<PlinyKeyTestResult> {
	const config = buildEffectiveProviderConfig(parseProviderId("pliny"))
	const baseUrl = (process.env.PLINY_BASE_URL || config.baseUrl?.trim() || PLINY_BASE_URL).replace(/\/+$/, "")
	const startedAt = deps.now()
	const result = (ok: boolean, status: number, message: string): PlinyKeyTestResult => ({
		ok,
		status,
		message,
		latencyMs: deps.now() - startedAt,
	})
	try {
		const model = await deps.modelId()
		const response = await deps.fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				...PLINY_DEFAULT_HEADERS,
				...(config.headers ?? {}),
				"Content-Type": "application/json",
				Authorization: `Bearer ${key.trim()}`,
			},
			body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
		})
		if (response.ok) {
			const done = result(true, response.status, "")
			return { ...done, message: `Connected: the Pliny inference server answered in ${done.latencyMs} ms.` }
		}
		if (response.status === 401 || response.status === 403) {
			return result(false, response.status, `The Pliny gateway rejected this key (HTTP ${response.status}).`)
		}
		const detail = await errorDetail(response)
		return result(
			false,
			response.status,
			`The Pliny inference server answered HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
		)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		Logger.warn(`[PlinyApiKeys] Key test could not reach the inference server: ${reason}`)
		return result(false, 0, `Could not reach the Pliny inference server: ${reason}`)
	}
}

/** The error message an OpenAI-style error body carries, or its first line, kept short. */
async function errorDetail(response: Response): Promise<string> {
	const body = await response.text().catch(() => "")
	let detail = body
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
		const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message)
		if (typeof message === "string") {
			detail = message
		}
	} catch {
		// Not JSON: keep the text.
	}
	const line = detail.trim().split(/\r?\n/)[0] ?? ""
	return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

import type {
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@plinycode/shared";

function resolveStickySession(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
):
	| {
			transport: "json-body" | "header";
			field: string;
			value: string;
	  }
	| undefined {
	const stickySession = context.provider.metadata?.stickySession;
	if (!stickySession) {
		return undefined;
	}
	const metadata = request.metadata;
	const value =
		metadata && typeof metadata === "object"
			? metadata[stickySession.metadataKey]
			: undefined;
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	return {
		transport: stickySession.transport,
		field: stickySession.field,
		value: trimmed,
	};
}

type FetchBodyText =
	| { source: "init-body"; text: string }
	| { request: Request; source: "request"; text: string };

async function bodyTextFromFetchInput(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
): Promise<FetchBodyText | undefined> {
	const body = init?.body;
	if (body === null) {
		return undefined;
	}
	if (typeof body === "string") {
		return { source: "init-body", text: body };
	}
	if (body instanceof URLSearchParams) {
		return { source: "init-body", text: body.toString() };
	}
	if (body instanceof ArrayBuffer) {
		return { source: "init-body", text: Buffer.from(body).toString("utf8") };
	}
	if (ArrayBuffer.isView(body)) {
		return {
			source: "init-body",
			text: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString(
				"utf8",
			),
		};
	}
	if (body !== undefined) {
		return undefined;
	}
	if (input instanceof Request) {
		try {
			return {
				request: input,
				source: "request",
				text: await input.clone().text(),
			};
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function injectJsonBodyStickySession(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	stickySession: { field: string; value: string },
): Promise<Parameters<typeof fetch>> {
	const bodyText = await bodyTextFromFetchInput(input, init);
	if (!bodyText?.text.trim().startsWith("{")) {
		return [input, init];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText.text);
	} catch {
		return [input, init];
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return [input, init];
	}
	const body = parsed as Record<string, unknown>;
	const existingValue = body[stickySession.field];
	if (typeof existingValue !== "string" || !existingValue.trim()) {
		body[stickySession.field] = stickySession.value;
	}
	const nextBody = JSON.stringify(body);
	if (bodyText.source === "init-body") {
		return [input, { ...init, body: nextBody }];
	}
	return [new Request(bodyText.request, { body: nextBody }), init];
}

function injectHeaderStickySession(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	stickySession: { field: string; value: string },
): Parameters<typeof fetch> {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	new Headers(init?.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	if (!headers.get(stickySession.field)?.trim()) {
		headers.set(stickySession.field, stickySession.value);
	}
	return [input, { ...init, headers }];
}

export function wrapFetchForStickySession(
	baseFetch: typeof fetch | undefined,
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): typeof fetch | undefined {
	const stickySession = resolveStickySession(request, context);
	if (!stickySession) {
		return baseFetch;
	}
	const delegate = baseFetch ?? globalThis.fetch;
	if (!delegate) {
		return baseFetch;
	}
	const sessionFetch = (async (input, init) => {
		const [nextInput, nextInit] =
			stickySession.transport === "json-body"
				? await injectJsonBodyStickySession(input, init, stickySession)
				: injectHeaderStickySession(input, init, stickySession);
		return delegate(nextInput, nextInit);
	}) as typeof fetch;
	const delegateWithPreconnect = delegate as typeof fetch & {
		preconnect?: (...args: unknown[]) => unknown;
	};
	if (typeof delegateWithPreconnect.preconnect === "function") {
		(
			sessionFetch as typeof fetch & {
				preconnect?: (...args: unknown[]) => unknown;
			}
		).preconnect = delegateWithPreconnect.preconnect.bind(delegate);
	}
	return sessionFetch;
}

import type {
	AgentModel,
	AgentModelEvent,
	AgentModelOutputLimit,
	AgentModelOutputLimitSource,
	AgentModelRequest,
	BasicLogger,
	GatewayConfig,
	GatewayModelDefinition,
	GatewayModelHandleOptions,
	GatewayModelSelection,
	GatewayProviderRegistration,
	GatewayStreamRequest,
	ITelemetryService,
	ReasoningEffort,
} from "@plinycode/shared";
import {
	estimateRequestInputTokens,
	ReasoningEffortSchema,
} from "@plinycode/shared";
import { toAsyncIterable } from "./async";
import { BUILTIN_PROVIDER_REGISTRATIONS } from "./builtins-runtime";
import { providerManifestSupportsModelOperation } from "./model-operations";
import { providerManifestSupportsModelTool } from "./model-tools";
import { GatewayRegistry } from "./registry";
import { isPositiveFiniteNumber } from "./utils";

export type * from "@plinycode/shared";

export const DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS = 32_000;
const GATEWAY_OUTPUT_RESERVE_TOKENS = 1_024;

function mergeRequestMetadata(
	defaults: Record<string, unknown> | undefined,
	request: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!defaults && !request) {
		return undefined;
	}
	return {
		...(defaults ?? {}),
		...(request ?? {}),
	};
}

function normalizeReasoningBudgetTokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function normalizeRequestedReasoning(
	value: unknown,
): GatewayStreamRequest["reasoning"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}

	const input = value as Record<string, unknown>;
	const parsedEffort = ReasoningEffortSchema.safeParse(input.effort);
	const normalized = {
		enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
		effort: parsedEffort.success ? parsedEffort.data : undefined,
		budgetTokens: normalizeReasoningBudgetTokens(input.budgetTokens),
	};

	return normalized.enabled !== undefined ||
		normalized.effort !== undefined ||
		normalized.budgetTokens !== undefined
		? normalized
		: undefined;
}

function mergeReasoningOptions(
	defaults: GatewayStreamRequest["reasoning"],
	legacy: GatewayStreamRequest["reasoning"],
	requested: GatewayStreamRequest["reasoning"],
): GatewayStreamRequest["reasoning"] {
	if (legacy?.enabled === false || requested?.enabled === false) {
		return { enabled: false };
	}

	const merged = {
		enabled: requested?.enabled ?? legacy?.enabled ?? defaults?.enabled,
		effort: requested?.effort ?? legacy?.effort ?? defaults?.effort,
		budgetTokens:
			requested?.budgetTokens ?? legacy?.budgetTokens ?? defaults?.budgetTokens,
	};
	if (
		merged.enabled === false &&
		(merged.effort !== undefined || merged.budgetTokens !== undefined)
	) {
		merged.enabled = undefined;
	}

	return Object.values(merged).some((value) => value !== undefined)
		? merged
		: undefined;
}

export interface Gateway {
	registerProvider(registration: GatewayProviderRegistration): this;
	configureProvider(
		config: NonNullable<GatewayConfig["providerConfigs"]>[number],
	): this;
	listProviders(): ReturnType<GatewayRegistry["listProviders"]>;
	listModels(providerId?: string): ReturnType<GatewayRegistry["listModels"]>;
	createAgentModel(
		selection: GatewayModelSelection,
		options?: GatewayModelHandleOptions,
	): AgentModel;
	stream(
		request: GatewayStreamRequest,
	): Promise<AsyncIterable<AgentModelEvent>>;
}

class GatewayModelAdapter implements AgentModel {
	constructor(
		private readonly gateway: DefaultGateway,
		private readonly selection: GatewayModelSelection,
		private readonly defaults: GatewayModelHandleOptions | undefined,
	) {}

	stream(request: AgentModelRequest): Promise<AsyncIterable<AgentModelEvent>> {
		const defaultReasoning = normalizeRequestedReasoning(
			this.defaults?.reasoning,
		);
		const requestedReasoning = normalizeRequestedReasoning(
			request.options?.reasoning,
		);
		const thinking = request.options?.thinking;
		const reasoningEffort = request.options?.reasoningEffort;
		const thinkingBudgetTokens = request.options?.thinkingBudgetTokens;
		const parsedLegacyEffort = ReasoningEffortSchema.safeParse(reasoningEffort);
		const legacyEffort: ReasoningEffort | undefined = parsedLegacyEffort.success
			? parsedLegacyEffort.data
			: undefined;
		const legacyBudgetTokens =
			normalizeReasoningBudgetTokens(thinkingBudgetTokens);
		const legacyReasoning:
			| {
					enabled?: boolean;
					effort?: ReasoningEffort;
					budgetTokens?: number;
			  }
			| undefined =
			typeof thinking === "boolean" ||
			legacyEffort !== undefined ||
			legacyBudgetTokens !== undefined
				? {
						enabled: typeof thinking === "boolean" ? thinking : undefined,
						effort: legacyEffort,
						budgetTokens: legacyBudgetTokens,
					}
				: undefined;
		return this.gateway.stream({
			providerId: this.selection.providerId,
			modelId: this.selection.modelId ?? "",
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: this.defaults?.tools ?? request.tools,
			modelTools: this.defaults?.modelTools ?? request.modelTools,
			temperature:
				(request.options?.temperature as number | undefined) ??
				this.defaults?.temperature,
			maxTokens:
				(request.options?.maxTokens as number | undefined) ??
				this.defaults?.maxTokens,
			metadata: mergeRequestMetadata(
				this.defaults?.metadata,
				request.options?.metadata as Record<string, unknown> | undefined,
			),
			reasoning: mergeReasoningOptions(
				defaultReasoning,
				legacyReasoning,
				requestedReasoning,
			),
			signal: request.signal ?? this.defaults?.signal,
		});
	}
}

type ResolveGatewayRequestMaxTokensInput = {
	requestedMaxTokens?: number;
	model: Pick<GatewayModelDefinition, "contextWindow" | "maxOutputTokens">;
	estimatedInputTokens: number;
	defaultMaxOutputTokens?: number;
	outputReserveTokens?: number;
	reasoningBudgetTokens?: number;
	onContextOverflow?: (details: {
		contextWindow: number;
		estimatedInputTokens: number;
		reserveTokens: number;
	}) => void;
};

export function resolveGatewayRequestMaxTokens(
	input: ResolveGatewayRequestMaxTokensInput,
): number | undefined {
	return resolveGatewayRequestMaxTokensDetailed(input).maxTokens;
}

/**
 * Like resolveGatewayRequestMaxTokens, but also reports which cap won so a
 * truncated turn can tell the user what to change. On a tie the more
 * actionable source wins: setting > model_limit > remaining_context > default.
 */
export function resolveGatewayRequestMaxTokensDetailed(
	input: ResolveGatewayRequestMaxTokensInput,
): { maxTokens: number | undefined; source: AgentModelOutputLimitSource } {
	const caps: Array<{ value: number; source: AgentModelOutputLimitSource }> =
		[];
	if (isPositiveFiniteNumber(input.requestedMaxTokens)) {
		caps.push({
			value: Math.floor(input.requestedMaxTokens),
			source: "setting",
		});
	} else {
		// Providers like Anthropic require max_tokens to exceed the thinking
		// budget, so an explicit reasoning budget lifts the synthesized default
		// (still clamped by model max output and remaining context below).
		const reasoningFloor = isPositiveFiniteNumber(input.reasoningBudgetTokens)
			? Math.floor(input.reasoningBudgetTokens) +
				(input.outputReserveTokens ?? GATEWAY_OUTPUT_RESERVE_TOKENS)
			: 0;
		const defaultMaxOutputTokens = Math.max(
			input.defaultMaxOutputTokens ?? DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS,
			reasoningFloor,
		);
		if (
			isPositiveFiniteNumber(input.model.maxOutputTokens) ||
			isPositiveFiniteNumber(input.model.contextWindow)
		) {
			caps.push({ value: defaultMaxOutputTokens, source: "default" });
		}
	}

	if (isPositiveFiniteNumber(input.model.maxOutputTokens)) {
		caps.push({
			value: Math.floor(input.model.maxOutputTokens),
			source: "model_limit",
		});
	}

	if (isPositiveFiniteNumber(input.model.contextWindow)) {
		const reserveTokens =
			input.outputReserveTokens ?? GATEWAY_OUTPUT_RESERVE_TOKENS;
		const remainingContext =
			input.model.contextWindow - input.estimatedInputTokens - reserveTokens;
		if (remainingContext <= 0) {
			input.onContextOverflow?.({
				contextWindow: input.model.contextWindow,
				estimatedInputTokens: input.estimatedInputTokens,
				reserveTokens,
			});
			return { maxTokens: undefined, source: "remaining_context" };
		}
		caps.push({
			value: Math.floor(remainingContext),
			source: "remaining_context",
		});
	}

	if (caps.length === 0) {
		return { maxTokens: undefined, source: "unknown" };
	}

	const priority: AgentModelOutputLimitSource[] = [
		"setting",
		"model_limit",
		"remaining_context",
		"default",
	];
	const min = Math.min(...caps.map((cap) => cap.value));
	const winner = caps
		.filter((cap) => cap.value === min)
		.sort((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source))[0];
	return {
		maxTokens: Math.max(1, Math.floor(min)),
		source: winner?.source ?? "unknown",
	};
}

/** Copies the applied output limit onto a max-tokens finish event. */
async function* withOutputLimit(
	events: AsyncIterable<AgentModelEvent>,
	outputLimit: AgentModelOutputLimit,
): AsyncIterable<AgentModelEvent> {
	for await (const event of events) {
		yield event.type === "finish" && event.reason === "max-tokens"
			? { ...event, outputLimit }
			: event;
	}
}

export class DefaultGateway implements Gateway {
	private readonly registry: GatewayRegistry;
	private readonly logger: BasicLogger | undefined;
	private readonly telemetry: ITelemetryService | undefined;

	constructor(config: GatewayConfig = {}) {
		this.registry = new GatewayRegistry(config.fetch);
		this.logger = config.logger;
		this.telemetry = config.telemetry;

		if (config.builtins !== false) {
			const builtins = new Set(
				config.builtins ??
					BUILTIN_PROVIDER_REGISTRATIONS.map(
						(provider) => provider.manifest.id,
					),
			);
			for (const builtin of BUILTIN_PROVIDER_REGISTRATIONS) {
				if (builtins.has(builtin.manifest.id)) {
					this.registry.registerProvider(builtin);
				}
			}
		}

		for (const provider of config.providers ?? []) {
			this.registry.registerProvider(provider);
		}

		for (const providerConfig of config.providerConfigs ?? []) {
			this.registry.configureProvider(providerConfig);
		}
	}

	registerProvider(registration: GatewayProviderRegistration): this {
		this.registry.registerProvider(registration);
		return this;
	}

	configureProvider(
		config: NonNullable<GatewayConfig["providerConfigs"]>[number],
	): this {
		this.registry.configureProvider(config);
		return this;
	}

	listProviders() {
		return this.registry.listProviders();
	}

	listModels(providerId?: string) {
		return this.registry.listModels(providerId);
	}

	createAgentModel(
		selection: GatewayModelSelection,
		options?: GatewayModelHandleOptions,
	): AgentModel {
		return new GatewayModelAdapter(this, selection, options);
	}

	async stream(
		request: GatewayStreamRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		const resolved = this.registry.resolveModel({
			providerId: request.providerId,
			modelId: request.modelId || undefined,
		});
		if (
			!providerManifestSupportsModelOperation(resolved.provider, resolved.model)
		) {
			throw new Error(
				`Provider "${resolved.provider.id}" does not support model "${resolved.model.id}" operation "${resolved.model.operation ?? "language"}" with its declared modalities.`,
			);
		}
		const unsupportedModelTools = [
			...new Set(
				(request.modelTools ?? [])
					.filter(
						(tool) =>
							!providerManifestSupportsModelTool(
								resolved.provider,
								resolved.model.id,
								tool.name,
							),
					)
					.map((tool) => tool.name),
			),
		];
		if (unsupportedModelTools.length > 0) {
			throw new Error(
				`Provider "${resolved.provider.id}" model "${resolved.model.id}" does not support model tool(s): ${unsupportedModelTools.join(", ")}.`,
			);
		}
		const providerRecord = await this.registry.createProvider(
			request.providerId,
		);
		const provider = await providerRecord.createProvider(providerRecord.config);
		const estimatedInputTokens = estimateRequestInputTokens(request);
		const { maxTokens, source: maxTokensSource } =
			resolveGatewayRequestMaxTokensDetailed({
				requestedMaxTokens: request.maxTokens,
				model: resolved.model,
				estimatedInputTokens,
				reasoningBudgetTokens: request.reasoning?.budgetTokens,
				onContextOverflow: (details) => {
					this.logger?.log(
						"Estimated prompt tokens exceed model context window",
						{
							severity: "warn",
							providerId: resolved.provider.id,
							modelId: resolved.model.id,
							...details,
						},
					);
				},
			});
		const stream = await provider.stream(
			{
				...request,
				modelId: resolved.model.id,
				providerId: resolved.provider.id,
				maxTokens,
				defaultedMaxTokens:
					maxTokens !== undefined && !isPositiveFiniteNumber(request.maxTokens),
			},
			{
				provider: resolved.provider,
				model: resolved.model,
				config: providerRecord.config,
				signal: request.signal,
				logger: this.logger,
				telemetry: this.telemetry,
			},
		);

		return withOutputLimit(toAsyncIterable(stream), {
			providerId: resolved.provider.id,
			modelId: resolved.model.id,
			maxTokens,
			source: maxTokensSource,
			modelMaxOutputTokens: resolved.model.maxOutputTokens,
			contextWindow: resolved.model.contextWindow,
			estimatedInputTokens,
		});
	}
}

export function createGateway(config?: GatewayConfig): DefaultGateway {
	return new DefaultGateway(config);
}

import type { ModelInfo } from "@shared/api"

/**
 * Formats a price as a currency string
 */
export const formatPrice = (price: number) => {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(price)
}

/**
 * Format a per-million-token price for compact display (e.g. "$5/M").
 */
export const formatCompactPrice = (price: number | undefined): string => {
	if (price === undefined) {
		return "N/A"
	}
	if (price === 0) {
		return "Free"
	}
	if (price < 0.01) {
		return `$${price.toFixed(4)}/M`
	}
	if (price < 1) {
		return `$${price.toFixed(2)}/M`
	}
	return `$${price % 1 === 0 ? price : price.toFixed(2)}/M`
}

/**
 * Format a token count for compact display (e.g. "200K", "1M").
 */
export const formatCompactContext = (tokens: number | undefined): string => {
	if (!tokens) {
		return "N/A"
	}
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
	}
	return `${Math.round(tokens / 1000)}K`
}

/** A dollar amount with 2–3 decimals, so $0.175 is not rounded to $0.18. */
const formatUsd = (price: number): string =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 3,
	}).format(price)

/**
 * Format a per-million-token price for the model details card: "Free",
 * "$0.175 / 1M tokens", or "—" when the price is not known.
 */
export const formatPricePerMillion = (price: number | undefined): string => {
	if (price === undefined) {
		return "—"
	}
	return price === 0 ? "Free" : `${formatUsd(price)} / 1M tokens`
}

/**
 * Short price label for a model row: "Free", "$3/$15" (input/output per 1M),
 * or `unknownLabel` when no price is known.
 */
export const formatRowPrice = (modelInfo: ModelInfo, unknownLabel = "price ?"): string => {
	if (modelInfo.pricingUnavailable) {
		return unknownLabel
	}
	const input = modelInfo.inputPrice ?? 0
	const output = modelInfo.outputPrice ?? 0
	if (input === 0 && output === 0) {
		return "Free"
	}
	const short = (price: number) => `$${Number(price.toFixed(3))}`
	return `${short(input)}/${short(output)}`
}

/** "32B", "1T", "30.7B" for a parameter count given in billions. */
export const formatParamCount = (billions: number): string => {
	if (billions >= 1000) {
		return `${Number((billions / 1000).toFixed(1))}T`
	}
	return `${Number(billions.toFixed(1))}B`
}

/**
 * Describe a model's size: "1T total · 32B active per token" for a
 * mixture-of-experts model, "70B (dense)" for a dense one, or undefined when
 * the counts are not published.
 */
export const formatParameters = (modelInfo: ModelInfo): string | undefined => {
	const { totalB, activeB } = modelInfo.parameters ?? {}
	if (totalB === undefined) {
		return activeB === undefined ? undefined : `${formatParamCount(activeB)} active per token`
	}
	if (activeB === undefined || activeB >= totalB) {
		return `${formatParamCount(totalB)} (dense)`
	}
	return `${formatParamCount(totalB)} total · ${formatParamCount(activeB)} active per token`
}

/**
 * Helper function to determine if a model supports thinking budget
 */
export const hasThinkingBudget = (modelInfo: ModelInfo): boolean => {
	return !!modelInfo.thinkingConfig && Object.keys(modelInfo.thinkingConfig).length > 0
}

/**
 * Helper function to check if a model supports images
 */
export const supportsImages = (modelInfo: ModelInfo): boolean => {
	return !!modelInfo.supportsImages
}

/**
 * Helper function to check if a model supports browser use
 */
export const supportsBrowserUse = (modelInfo: ModelInfo): boolean => {
	return !!modelInfo.supportsImages // browser tool uses image recognition
}

/**
 * Helper function to check if a model supports prompt caching
 */
export const supportsPromptCache = (modelInfo: ModelInfo): boolean => {
	return !!modelInfo.supportsPromptCache
}

/**
 * Parses a price input string to a number, handling edge cases like
 * incomplete decimals (e.g., ".", ".5", "0.") gracefully.
 *
 * @param value - The input string to parse
 * @param defaultValue - The fallback value if input is empty or invalid
 * @returns A valid number, or the default value if parsing fails
 */
export const parsePrice = (value: string, defaultValue: number): number => {
	if (value === "" || value === ".") {
		return defaultValue
	}
	const num = Number.parseFloat(value)
	return isNaN(num) ? defaultValue : num
}

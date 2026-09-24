import type { GatewayStreamRequest } from "@plinycode/shared";
import {
	type PlinyThinkingControls,
	plinyThinkingControls,
} from "../pliny-models";

/**
 * Pliny self-hosted reasoning switches.
 *
 * The self-hosted pool is served by different backends that disagree on how
 * reasoning is switched: some honour `chat_template_kwargs.enable_thinking`,
 * some `reasoning_effort`, some neither, and an unknown value such as
 * `reasoning_effort: "none"` is rejected with a 400 rather than ignored. So the
 * field is chosen per model from the measured catalog entry, and nothing is
 * sent for a model that was not measured or has no switch in that direction.
 *
 * Only the off direction is handled here. Turning reasoning on is owned by the
 * portable top-level `reasoning_effort`, which strips the request's reasoning
 * before provider rules run, so a model whose only on-switch is the chat
 * template cannot be switched on from here (see `plinyCanThink`).
 */
export function plinyThinkingFields(
	enabled: boolean | undefined,
	controls: PlinyThinkingControls | undefined,
): Record<string, unknown> | undefined {
	if (enabled !== false || !controls?.defaultOn) {
		return undefined;
	}
	switch (controls.off) {
		case "template-kwargs":
			return { chat_template_kwargs: { enable_thinking: false } };
		case "reasoning-effort-none":
			return { reasoning_effort: "none" };
		case "reasoning-exclude":
			return { reasoning: { exclude: true } };
		default:
			return undefined;
	}
}

/** True when the Pliny catalog has measured reasoning controls for the model. */
export function hasPlinyThinkingControls(
	request: Pick<GatewayStreamRequest, "providerId" | "modelId">,
): boolean {
	return (
		request.providerId === "pliny" &&
		plinyThinkingControls(request.modelId) !== undefined
	);
}

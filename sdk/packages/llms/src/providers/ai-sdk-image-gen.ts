import type {
	AgentMessage,
	GatewayProviderContext,
	GatewayStreamRequest,
	GeneratedMedia,
	ImageMediaValidationFailure,
	ImageMediaValidationSuccess,
	MediaBudgetState,
} from "@plinycode/shared";
import {
	GeneratedMediaSchema,
	validateAndReserveBase64Media,
	validateAndReserveImageMedia,
	validateImageMedia,
} from "@plinycode/shared";
import { nanoid } from "nanoid";
import type { ProviderGeneratedMedia } from "./vendors/types";

type ImageGenerationInput = string | Uint8Array | ArrayBuffer;
type ImageGenerationPrompt =
	| string
	| {
			images: ImageGenerationInput[];
			text?: string;
	  };

function normalizeImageGenerationInput(
	part: Extract<AgentMessage["content"][number], { type: "image" }>,
): ImageGenerationInput {
	if (part.image instanceof URL) {
		return part.image.href;
	}
	if (typeof part.image !== "string") {
		return part.image;
	}
	if (part.image.startsWith("http://") || part.image.startsWith("https://")) {
		return part.image;
	}
	const validation = validateImageMedia(part.mediaType, part.image);
	if (!validation.ok) {
		throw new Error(validation.message);
	}
	return `data:${validation.mediaType};base64,${validation.base64}`;
}

function normalizeGeneratedImageInput(
	part: Extract<AgentMessage["content"][number], { type: "media" }>,
): ImageGenerationInput | undefined {
	if (part.media.modality !== "image") return undefined;
	switch (part.media.source.type) {
		case "url":
			return part.media.source.url;
		case "artifact":
			return undefined;
		case "base64": {
			const validation = validateImageMedia(
				part.media.mediaType,
				part.media.source.data,
			);
			return validation.ok
				? `data:${validation.mediaType};base64,${validation.base64}`
				: undefined;
		}
	}
}

export function resolveImageGenerationPrompt(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): ImageGenerationPrompt {
	let latestUserMessageIndex = -1;
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		if (request.messages[index]?.role === "user") {
			latestUserMessageIndex = index;
			break;
		}
	}
	if (latestUserMessageIndex < 0) {
		throw new Error("Image generation requires a text prompt or input image");
	}

	const message = request.messages[latestUserMessageIndex];
	if (!message || message.role !== "user") {
		throw new Error("Image generation requires a text prompt or input image");
	}
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	const supportsImageInput =
		context.model.modalities?.input.includes("image") === true;
	if (supportsImageInput) {
		const explicitImages = message.content
			.filter((part) => part.type === "image")
			.map(normalizeImageGenerationInput);
		if (explicitImages.length > 0) {
			return {
				images: explicitImages,
				...(text ? { text } : {}),
			};
		}
	}
	if (!text) {
		throw new Error("Image generation requires a text prompt or input image");
	}
	if (!supportsImageInput) {
		return text;
	}

	// Only infer an edit from the immediately preceding assistant turn. Looking
	// farther back can silently turn a new generation request into an edit of a
	// stale image from an unrelated part of the conversation.
	const previousMessage = request.messages[latestUserMessageIndex - 1];
	if (previousMessage?.role === "assistant") {
		const firstGeneratedImage = previousMessage.content.find(
			(part) =>
				part.type === "image" ||
				(part.type === "media" && part.media.modality === "image"),
		);
		if (firstGeneratedImage?.type === "image") {
			return {
				text,
				images: [normalizeImageGenerationInput(firstGeneratedImage)],
			};
		}
		if (firstGeneratedImage?.type === "media") {
			const input = normalizeGeneratedImageInput(firstGeneratedImage);
			if (input) return { text, images: [input] };
		}
	}
	return text;
}

type GeneratedImageExtraction =
	| { kind: "accepted"; image: ImageMediaValidationSuccess }
	| { kind: "rejected"; error: ImageMediaValidationFailure }
	| { kind: "unsupported" };

export function toGeneratedImageMedia(
	image: ImageMediaValidationSuccess,
): GeneratedMedia {
	return {
		id: `media_${nanoid()}`,
		modality: "image",
		mediaType: image.mediaType,
		source: { type: "base64", data: image.base64 },
		sizeBytes: image.decodedBytes,
	};
}

export function extractGeneratedImage(
	file: unknown,
	budgetState: MediaBudgetState,
): GeneratedImageExtraction {
	if (!file || typeof file !== "object") return { kind: "unsupported" };
	const record = file as Record<string, unknown>;
	if (
		typeof record.mediaType !== "string" ||
		!record.mediaType.startsWith("image/") ||
		typeof record.base64 !== "string"
	) {
		return { kind: "unsupported" };
	}
	// Generated images use the same bounded media envelope as attachments and
	// persisted history. Accepting an image that hydration later drops would
	// make the live and replayed assistant transcripts disagree.
	const validation = validateAndReserveImageMedia(
		record.mediaType,
		record.base64,
		{},
		budgetState,
	);
	if (!validation.ok) {
		return { kind: "rejected", error: validation };
	}
	return { kind: "accepted", image: validation };
}

type ProjectedMediaNormalization =
	| { ok: true; media: GeneratedMedia }
	| { ok: false; error: string };

export function normalizeProjectedModelToolMedia(
	candidate: ProviderGeneratedMedia,
	budgetState: MediaBudgetState,
): ProjectedMediaNormalization {
	if (candidate.modality === "image" && candidate.source.type === "base64") {
		const extracted = extractGeneratedImage(
			{
				base64: candidate.source.data,
				mediaType: candidate.mediaType,
			},
			budgetState,
		);
		if (extracted.kind === "accepted") {
			return { ok: true, media: toGeneratedImageMedia(extracted.image) };
		}
		return {
			ok: false,
			error:
				extracted.kind === "rejected"
					? extracted.error.message
					: "Model tool returned unsupported image media",
		};
	}

	let source = candidate.source;
	let sizeBytes: number | undefined;
	if (candidate.source.type === "base64") {
		const validation = validateAndReserveBase64Media(
			candidate.source.data,
			{},
			budgetState,
		);
		if (!validation.ok) {
			return { ok: false, error: validation.message };
		}
		source = { type: "base64", data: validation.base64 };
		sizeBytes = validation.decodedBytes;
	}

	const media = {
		...candidate,
		id: `media_${nanoid()}`,
		source,
		...(sizeBytes !== undefined ? { sizeBytes } : {}),
	};
	const parsed = GeneratedMediaSchema.safeParse(media);
	return parsed.success
		? { ok: true, media: parsed.data }
		: { ok: false, error: "Model tool returned invalid generated media" };
}

export function summarizeProjectedMedia(
	media: readonly GeneratedMedia[],
): unknown {
	return {
		generatedMediaCount: media.length,
		mediaTypes: media.map((item) => item.mediaType),
		byteLength: media.reduce((total, item) => total + (item.sizeBytes ?? 0), 0),
	};
}

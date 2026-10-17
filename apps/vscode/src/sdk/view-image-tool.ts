/**
 * `view_image`: lets the agent look at an image file in the workspace, such as
 * a screenshot a test or the user wrote to disk, a diagram or a UI mockup.
 *
 * An extension cannot take a screenshot itself (VS Code has no screen-capture
 * API, and its clipboard API is text-only), so files are the way in.
 *
 * The tool returns the image as an image block next to a line of text, the
 * shape `read_files` uses for images. An image-capable model receives the
 * image itself; on FreeAuto and BalanceAuto a free model receives the router's
 * description of it instead (`router/router-images.ts`, `plinycode.router.images`).
 * A conversation on a concrete model that cannot see images gets an error.
 */

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { type AgentTool, type AgentToolContext, DEFAULT_MAX_IMAGE_ENCODED_BYTES } from "@plinycode/shared"

const VIEW_IMAGE_TOOL_NAME = "view_image"

/** The largest file whose base64 still fits the gateway's 5 MB per-image limit. */
const MAX_IMAGE_BYTES = Math.floor((DEFAULT_MAX_IMAGE_ENCODED_BYTES * 3) / 4)

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

const TYPE_LABELS: Record<ImageMediaType, string> = {
	"image/png": "PNG",
	"image/jpeg": "JPEG",
	"image/gif": "GIF",
	"image/webp": "WebP",
}

/** The image type a file's first bytes announce, whatever its extension says. */
function detectImageType(bytes: Uint8Array): ImageMediaType | undefined {
	const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) {
		return "image/png"
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg"
	}
	if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
		return "image/gif"
	}
	if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
		return "image/webp"
	}
	return undefined
}

/** Width and height from the image's header, when they can be read cheaply. */
function imageDimensions(bytes: Buffer, type: ImageMediaType): { width: number; height: number } | undefined {
	try {
		if (type === "image/png" && bytes.length >= 24) {
			return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
		}
		if (type === "image/gif" && bytes.length >= 10) {
			return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
		}
		if (type === "image/webp" && bytes.length >= 30) {
			const chunk = bytes.toString("ascii", 12, 16)
			if (chunk === "VP8X") {
				return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
			}
			if (chunk === "VP8L") {
				const bits = bytes.readUInt32LE(21)
				return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
			}
			if (chunk === "VP8 ") {
				return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
			}
		}
		if (type === "image/jpeg") {
			// Walk the segments to the first start-of-frame marker.
			let offset = 2
			while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
				const marker = bytes[offset + 1]
				const length = bytes.readUInt16BE(offset + 2)
				const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
				if (isStartOfFrame) {
					return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
				}
				offset += 2 + length
			}
		}
	} catch {
		// A truncated header just means no dimensions.
	}
	return undefined
}

function formatSize(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Whether `target` is `root` or inside it; both already resolved and real. */
function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target)
	if (relative === "") {
		return true
	}
	return !relative.startsWith("..") && !path.isAbsolute(relative)
}

async function realpathOrSelf(value: string): Promise<string> {
	try {
		return await fs.realpath(value)
	} catch {
		return value
	}
}

interface ViewImageToolOptions {
	/**
	 * The session's working directory (the workspace root, or the conversation's
	 * worktree): relative paths resolve against it, and files must lie inside it.
	 */
	cwd: string
}

export function createViewImageTool(options: ViewImageToolOptions): AgentTool {
	return {
		name: VIEW_IMAGE_TOOL_NAME,
		description:
			"Look at an image file in the workspace: a screenshot a test or the user saved, a diagram, a UI mockup, a " +
			`rendered chart. PNG, JPEG, GIF or WebP, at most ${formatSize(MAX_IMAGE_BYTES)}. You receive the image itself, ` +
			"or, when your model cannot see images, a faithful text description of it. The path is relative to the " +
			"workspace root (or absolute inside the workspace). Use it when the user refers to an image file or when a " +
			"tool you ran saved one; text files are read with read_files.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path of the image file, relative to the workspace root.",
				},
			},
			required: ["path"],
		},
		executionMode: "parallel",
		timeoutMs: 30_000,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<unknown> {
			const input = (rawInput ?? {}) as { path?: unknown }
			const requested = typeof input.path === "string" ? input.path.trim() : ""
			if (!requested) {
				throw new Error("view_image needs a `path`.")
			}
			if (context.metadata?.modelSupportsImages !== true) {
				throw new Error(
					"The current model cannot view images. Images can be viewed on auto-free and auto-paid-balanced, which " +
						"describe them for models that cannot see them, or on an image-capable model.",
				)
			}

			const absolute = path.resolve(options.cwd, requested)
			const real = await realpathOrSelf(absolute)
			// Both sides resolved through symlinks, so a link cannot lead out of the workspace.
			const root = await realpathOrSelf(path.resolve(options.cwd))
			const comparable = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
			if (!isInside(comparable(root), comparable(real))) {
				throw new Error(`${requested} is outside the workspace; view_image only opens files inside it.`)
			}

			let stat: Awaited<ReturnType<typeof fs.stat>>
			try {
				stat = await fs.stat(real)
			} catch {
				throw new Error(`${requested} does not exist.`)
			}
			if (!stat.isFile()) {
				throw new Error(`${requested} is not a file.`)
			}
			if (stat.size > MAX_IMAGE_BYTES) {
				throw new Error(
					`${requested} is ${formatSize(stat.size)}; view_image opens images up to ${formatSize(MAX_IMAGE_BYTES)}. ` +
						"Save a smaller or more compressed copy (for example a JPEG, or a crop of the part that matters) and view that.",
				)
			}

			const bytes = await fs.readFile(real)
			const type = detectImageType(bytes)
			if (!type) {
				throw new Error(`${requested} is not a PNG, JPEG, GIF or WebP image.`)
			}
			const dimensions = imageDimensions(bytes, type)
			const display = path.relative(root, real).replace(/\\/g, "/")
			const facts = [
				TYPE_LABELS[type],
				dimensions ? `${dimensions.width}×${dimensions.height}` : undefined,
				formatSize(bytes.length),
			]
			return [
				{ type: "text", text: `Image ${display} (${facts.filter(Boolean).join(", ")})` },
				{ type: "image", data: bytes.toString("base64"), mediaType: type },
			]
		},
	}
}

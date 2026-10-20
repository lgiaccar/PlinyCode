import fs from "fs/promises"
import sizeOf from "image-size"
import * as path from "path"
import { StringArray, StringArrayRequest } from "@shared/proto/cline/common"
import { URI } from "vscode-uri"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const MIME_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
}
const MAX_IMAGE_DIMENSION = 7500

/** Converts Explorer-dropped local image URIs into validated data URLs for chat. */
export async function readDroppedImages(_controller: Controller, request: StringArrayRequest): Promise<StringArray> {
	const images = await Promise.all(
		request.value.map(async (uriString) => {
			try {
				const uri = URI.parse(uriString, true)
				if (uri.scheme !== "file" && uri.scheme !== "vscode-file") {
					return null
				}
				const mimeType = MIME_TYPES[path.extname(uri.fsPath).toLowerCase()]
				if (!mimeType) {
					return null
				}
				const buffer = await fs.readFile(uri.fsPath)
				const dimensions = sizeOf(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
				if (dimensions.width! > MAX_IMAGE_DIMENSION || dimensions.height! > MAX_IMAGE_DIMENSION) {
					Logger.warn(`Image dimensions exceed ${MAX_IMAGE_DIMENSION}px, skipping: ${uri.fsPath}`)
					return null
				}
				return `data:${mimeType};base64,${buffer.toString("base64")}`
			} catch (error) {
				Logger.error(`Could not read dropped image ${uriString}:`, error)
				return null
			}
		}),
	)
	return StringArray.create({ values: images.filter((image): image is string => image !== null) })
}

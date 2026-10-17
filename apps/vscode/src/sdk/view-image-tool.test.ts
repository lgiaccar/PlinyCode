import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentToolContext } from "@plinycode/shared"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sdkToolToClineSayTool } from "./message-translator/tool-mapping"
import { buildToolPolicies, isToolAutoApproved } from "./sdk-tool-policies"
import { createViewImageTool } from "./view-image-tool"

// A 1x1 PNG.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
)
// The first bytes of a GIF (2x3) and a JPEG with a 640x480 start-of-frame.
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([2, 0, 3, 0, 0, 0, 0])])
const JPEG = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
])

const CAN_SEE: AgentToolContext = { metadata: { modelSupportsImages: true } } as unknown as AgentToolContext
const CANNOT_SEE: AgentToolContext = { metadata: { modelSupportsImages: false } } as unknown as AgentToolContext

let root: string
let workspace: string

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "view-image-"))
	workspace = path.join(root, "workspace")
	await fs.mkdir(path.join(workspace, "shots"), { recursive: true })
	await fs.writeFile(path.join(workspace, "shots", "button.png"), PNG)
	// The content decides the type, not the extension.
	await fs.writeFile(path.join(workspace, "shots", "really-a-png.jpg"), PNG)
	await fs.writeFile(path.join(workspace, "anim.gif"), GIF)
	await fs.writeFile(path.join(workspace, "photo.jpeg"), JPEG)
	await fs.writeFile(path.join(workspace, "notes.png"), "not an image at all")
	await fs.writeFile(path.join(workspace, "huge.png"), Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]))
	await fs.writeFile(path.join(root, "outside.png"), PNG)
})

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

const view = (input: unknown, context: AgentToolContext = CAN_SEE) =>
	createViewImageTool({ cwd: workspace }).execute(input, context) as Promise<Array<Record<string, unknown>>>

describe("view_image", () => {
	it("returns the image as an image block after a line naming it", async () => {
		const output = await view({ path: "shots/button.png" })
		expect(output).toEqual([
			{ type: "text", text: "Image shots/button.png (PNG, 1×1, 1 KB)" },
			{ type: "image", data: PNG.toString("base64"), mediaType: "image/png" },
		])
	})

	it("accepts an absolute path inside the workspace", async () => {
		const output = await view({ path: path.join(workspace, "shots", "button.png") })
		expect(output[1]).toMatchObject({ type: "image", mediaType: "image/png" })
	})

	it("detects the type from the content, and reads the size from the header", async () => {
		expect((await view({ path: "shots/really-a-png.jpg" }))[1]).toMatchObject({ mediaType: "image/png" })
		expect((await view({ path: "anim.gif" }))[0]).toEqual({ type: "text", text: "Image anim.gif (GIF, 2×3, 1 KB)" })
		expect((await view({ path: "photo.jpeg" }))[0]).toEqual({ type: "text", text: "Image photo.jpeg (JPEG, 640×480, 1 KB)" })
	})

	it("refuses a file that is not an image, whatever its extension", async () => {
		await expect(view({ path: "notes.png" })).rejects.toThrow("is not a PNG, JPEG, GIF or WebP image")
	})

	it("refuses paths outside the workspace", async () => {
		await expect(view({ path: "../outside.png" })).rejects.toThrow("is outside the workspace")
		await expect(view({ path: path.join(root, "outside.png") })).rejects.toThrow("is outside the workspace")
	})

	it("refuses files over the size cap, and says what to do instead", async () => {
		await expect(view({ path: "huge.png" })).rejects.toThrow(/huge\.png is 4\.0 MB; view_image opens images up to 3\.8 MB/)
	})

	it("reports a missing file, a directory and a missing path", async () => {
		await expect(view({ path: "shots/missing.png" })).rejects.toThrow("does not exist")
		await expect(view({ path: "shots" })).rejects.toThrow("is not a file")
		await expect(view({})).rejects.toThrow("needs a `path`")
	})

	it("refuses when the conversation's model cannot see images", async () => {
		await expect(view({ path: "shots/button.png" }, CANNOT_SEE)).rejects.toThrow("The current model cannot view images")
	})

	it("is a parallel read tool, approved with the file reads and shown as one", () => {
		const tool = createViewImageTool({ cwd: workspace })
		expect(tool.name).toBe("view_image")
		expect(tool.executionMode).toBe("parallel")
		const readsOff = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: false },
		}
		expect(isToolAutoApproved("view_image", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(true)
		expect(isToolAutoApproved("view_image", readsOff)).toBe(false)
		expect(buildToolPolicies(DEFAULT_AUTO_APPROVAL_SETTINGS).view_image).toEqual({ autoApprove: false })
		expect(sdkToolToClineSayTool("view_image", { path: "shots/button.png" })).toEqual({
			tool: "readFile",
			path: "shots/button.png",
		})
	})
})

import { afterEach, beforeEach, describe, it, mock } from "bun:test"
import { expect } from "chai"
import * as sinon from "sinon"

// bun loads real ESM, so the host bridge and fs namespaces cannot be stubbed in
// place ("ES Modules cannot be stubbed"). Inject module-level sinon stubs via
// mock.module so the full sinon API keeps working.
const showSaveDialogStub: sinon.SinonStub = sinon.stub()
const showMessageStub: sinon.SinonStub = sinon.stub()
const showTextDocumentStub: sinon.SinonStub = sinon.stub()
const writeFileStub: sinon.SinonStub = sinon.stub()

mock.module("@/hosts/host-provider", () => ({
	HostProvider: {
		window: {
			showSaveDialog: showSaveDialogStub,
			showMessage: showMessageStub,
			showTextDocument: showTextDocumentStub,
		},
	},
}))
mock.module("node:fs/promises", () => ({ writeFile: writeFileStub, default: { writeFile: writeFileStub } }))

const loggerLogStub: sinon.SinonStub = sinon.stub()
mock.module("@/shared/services/Logger", () => ({ Logger: { log: loggerLogStub, error: sinon.stub(), warn: sinon.stub() } }))

import { defaultMarkdownExportFilename, saveMarkdownExport } from "../save-markdown"

const SAVE_OPTIONS = { defaultDirectory: "/workspace/demo", defaultFilename: "plinycode-conversation-20231114-2213.md" }

describe("saveMarkdownExport", () => {
	beforeEach(() => {
		showSaveDialogStub.reset()
		showMessageStub.reset()
		showTextDocumentStub.reset()
		writeFileStub.reset()
		loggerLogStub.reset()
		showMessageStub.resolves({ selectedOption: undefined })
		showTextDocumentStub.resolves({})
		writeFileStub.resolves(undefined)
	})

	afterEach(() => {
		sinon.reset()
	})

	it("writes nothing and returns undefined when the dialog is cancelled", async () => {
		showSaveDialogStub.resolves({ selectedPath: undefined })

		const result = await saveMarkdownExport("# hi\n", SAVE_OPTIONS)

		expect(result).to.equal(undefined)
		expect(writeFileStub.called).to.equal(false)
		expect(showMessageStub.called).to.equal(false)
		expect(showTextDocumentStub.called).to.equal(false)
	})

	it("writes nothing when the dialog returns an empty path", async () => {
		showSaveDialogStub.resolves({ selectedPath: "" })

		expect(await saveMarkdownExport("# hi\n", SAVE_OPTIONS)).to.equal(undefined)
		expect(writeFileStub.called).to.equal(false)
	})

	it("writes the markdown to the chosen path and returns it", async () => {
		showSaveDialogStub.resolves({ selectedPath: "/chosen/conversation.md" })

		const result = await saveMarkdownExport("# hi\n", SAVE_OPTIONS)

		expect(result).to.equal("/chosen/conversation.md")
		expect(writeFileStub.calledOnceWith("/chosen/conversation.md", "# hi\n", "utf8")).to.equal(true)
	})

	it("offers the default filename inside the default directory", async () => {
		showSaveDialogStub.resolves({ selectedPath: "/chosen/conversation.md" })

		await saveMarkdownExport("# hi\n", SAVE_OPTIONS)

		const defaultPath = showSaveDialogStub.firstCall.args[0].options.defaultPath as string
		expect(defaultPath.replace(/\\/g, "/")).to.equal("/workspace/demo/plinycode-conversation-20231114-2213.md")
	})

	it("opens the written file when the user picks Open file", async () => {
		showSaveDialogStub.resolves({ selectedPath: "/chosen/conversation.md" })
		showMessageStub.resolves({ selectedOption: "Open file" })

		await saveMarkdownExport("# hi\n", SAVE_OPTIONS)

		expect(showTextDocumentStub.calledOnce).to.equal(true)
		expect(showTextDocumentStub.firstCall.args[0].path).to.equal("/chosen/conversation.md")
	})

	it("leaves the file closed when the notification is dismissed", async () => {
		showSaveDialogStub.resolves({ selectedPath: "/chosen/conversation.md" })

		await saveMarkdownExport("# hi\n", SAVE_OPTIONS)

		expect(showTextDocumentStub.called).to.equal(false)
	})
})

describe("defaultMarkdownExportFilename", () => {
	it("stamps the local date and time as yyyyMMdd-HHmm", () => {
		const ts = new Date(2023, 10, 14, 22, 13).getTime()
		expect(defaultMarkdownExportFilename(ts)).to.equal("plinycode-conversation-20231114-2213.md")
	})

	it("zero-pads single-digit components", () => {
		const ts = new Date(2024, 0, 5, 7, 9).getTime()
		expect(defaultMarkdownExportFilename(ts)).to.equal("plinycode-conversation-20240105-0709.md")
	})
})

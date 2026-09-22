import { afterEach, beforeEach, describe, it } from "bun:test"
import type { Controller } from "@core/controller"
import { ExportTaskRequest } from "@shared/proto/cline/task"
import { expect } from "chai"
import * as sinon from "sinon"
import { exportTaskToMarkdown } from "../exportTaskToMarkdown"

describe("exportTaskToMarkdown", () => {
	let sandbox: sinon.SinonSandbox
	let exportStub: sinon.SinonStub
	let controller: Controller

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		exportStub = sandbox.stub()
		controller = { exportTaskToMarkdown: exportStub } as unknown as Controller
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("returns the written path", async () => {
		exportStub.resolves("/workspace/plinycode-conversation-20231114-2213.md")

		const result = await exportTaskToMarkdown(controller, ExportTaskRequest.create({ taskId: "task-1" }))

		expect(result.path).to.equal("/workspace/plinycode-conversation-20231114-2213.md")
	})

	it("returns an empty path when the save dialog was cancelled", async () => {
		// A cancelled dialog resolves undefined and writes nothing; the handler
		// must surface that as an empty path rather than an error.
		exportStub.resolves(undefined)

		const result = await exportTaskToMarkdown(controller, ExportTaskRequest.create({ taskId: "task-1" }))

		expect(result.path).to.equal("")
	})

	it("forwards the include flags to the controller", async () => {
		exportStub.resolves("/tmp/out.md")

		await exportTaskToMarkdown(
			controller,
			ExportTaskRequest.create({ taskId: "task-1", includeToolOutput: false, includeReasoning: true }),
		)

		expect(exportStub.calledOnce).to.equal(true)
		expect(exportStub.firstCall.args[0]).to.equal("task-1")
		expect(exportStub.firstCall.args[1]).to.deep.equal({ includeToolOutput: false, includeReasoning: true })
	})

	it("propagates controller failures for gRPC error handling", async () => {
		exportStub.rejects(new Error("Task not found in history: nope"))

		let thrown: unknown
		try {
			await exportTaskToMarkdown(controller, ExportTaskRequest.create({ taskId: "nope" }))
		} catch (error) {
			thrown = error
		}

		expect((thrown as Error).message).to.equal("Task not found in history: nope")
	})
})

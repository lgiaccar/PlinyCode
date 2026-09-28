import { expect } from "chai"
import "should"
import { afterEach, beforeEach, describe, it, mock } from "bun:test"
import * as actualProtobusServices from "@generated/hosts/vscode/protobus-services"
import * as sinon from "sinon"
import { Controller } from "@/core/controller"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import type { GrpcRequest } from "@/shared/WebviewMessage"

// bun loads real ESM, so sinon cannot replace the `serviceHandlers` namespace
// binding ("Cannot replace module namespace object's binding's value"). Route it
// through a STABLE object reference installed via mock.module; the SUT reads
// `serviceHandlers[serviceName]` at call time, so each test mutates the contents
// of this same object (clearing then assigning) rather than swapping the binding.
const currentServiceHandlers: Record<string, unknown> = {}
mock.module("@generated/hosts/vscode/protobus-services", () => ({
	...actualProtobusServices,
	serviceHandlers: currentServiceHandlers,
}))

import { handleGrpcRequest } from "@/core/controller/grpc-handler"

describe("GrpcHandler", () => {
	let mockController: sinon.SinonStubbedInstance<Controller>
	let mockPostMessage: sinon.SinonStub

	beforeEach(() => {
		mockController = sinon.createStubInstance(Controller)
		mockPostMessage = sinon.stub().resolves(true)

		const mockServiceHandlers = {
			TestService: {
				testMethod: sinon.stub().resolves({ success: true }),
				errorMethod: sinon.stub().rejects(new Error("Simulated failure")),
			},
		}

		for (const key of Object.keys(currentServiceHandlers)) {
			delete currentServiceHandlers[key]
		}
		Object.assign(currentServiceHandlers, mockServiceHandlers)
	})

	afterEach(() => {
		sinon.restore()
	})

	const unaryRequest = (method: string): GrpcRequest => ({
		request_id: "the-request-id",
		service: "TestService",
		method,
		message: { test: "request" },
		is_streaming: false,
	})

	it("posts the handler's result for a unary call", async () => {
		await handleGrpcRequest(mockController, mockPostMessage, unaryRequest("testMethod"))

		expect(mockPostMessage.calledOnce).to.be.true
		const sentMessage = mockPostMessage.getCall(0).args[0] as ExtensionMessage
		expect(sentMessage.type).to.equal("grpc_response")
		expect(sentMessage.grpc_response?.request_id).to.equal("the-request-id")
		expect(sentMessage.grpc_response?.message).to.deep.equal({ success: true })
	})

	it("posts the error message when a unary handler fails", async () => {
		await handleGrpcRequest(mockController, mockPostMessage, unaryRequest("errorMethod"))

		expect(mockPostMessage.calledOnce).to.be.true
		const sentMessage = mockPostMessage.getCall(0).args[0] as ExtensionMessage
		expect(sentMessage.grpc_response?.request_id).to.equal("the-request-id")
		expect(sentMessage.grpc_response?.error).to.equal("Simulated failure")
	})
})

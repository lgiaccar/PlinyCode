import { afterEach, beforeEach, describe, it } from "bun:test"
import { expect } from "chai"
import * as sinon from "sinon"
import { WebviewProvider } from "@/core/webview"
import { Logger } from "@/shared/services/Logger"

import { ErrorService } from "../error"
import { SharedUriHandler } from "./SharedUriHandler"

describe("SharedUriHandler", () => {
	let sandbox: sinon.SinonSandbox
	let handleTaskCreationStub: sinon.SinonStub

	beforeEach(async () => {
		sandbox = sinon.createSandbox()

		// Mock Logger methods to avoid HostProvider dependency
		sandbox.stub(Logger, "info").returns()
		sandbox.stub(Logger, "error").returns()
		// Mock ErrorService to avoid telemetry dependency
		const mockErrorService = {
			logMessage: sandbox.stub(),
			logException: sandbox.stub(),
			toClineError: sandbox.stub(),
			isEnabled: sandbox.stub().returns(false),
			getSettings: sandbox.stub().returns({ enabled: false, hostEnabled: false }),
			getProvider: sandbox.stub(),
			dispose: sandbox.stub().resolves(),
		}
		sandbox.stub(ErrorService, "initialize").resolves(mockErrorService as any)
		sandbox.stub(ErrorService, "get").returns(mockErrorService as any)

		await ErrorService.initialize()

		handleTaskCreationStub = sandbox.stub().resolves()
		const mockWebviewProvider = {
			controller: {
				handleTaskCreation: handleTaskCreationStub,
			},
		} as any
		sandbox.stub(WebviewProvider, "getVisibleInstance").returns(mockWebviewProvider)
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("handleUri", () => {
		describe("Task creation", () => {
			it("creates a task from the prompt parameter", async () => {
				const result = await SharedUriHandler.handleUri("vscode://cline.cline/task?prompt=hello")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(handleTaskCreationStub, "hello")
			})

			it("returns false when the prompt is missing", async () => {
				const result = await SharedUriHandler.handleUri("vscode://cline.cline/task")

				expect(result).to.be.false
				expect(handleTaskCreationStub.called).to.be.false
			})

			it("preserves plus signs in the prompt", async () => {
				const result = await SharedUriHandler.handleUri("vscode://cline.cline/task?prompt=a+b")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(handleTaskCreationStub, "a+b")
			})

			it("decodes URL-encoded parameters", async () => {
				const result = await SharedUriHandler.handleUri("vscode://cline.cline/task?prompt=fix%20the%20bug&extra=param")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(handleTaskCreationStub, "fix the bug")
			})

			it("accepts HTTP scheme URIs", async () => {
				const result = await SharedUriHandler.handleUri("http://localhost:3000/task?prompt=hello")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(handleTaskCreationStub, "hello")
			})
		})

		describe("Unknown paths", () => {
			it("returns false for unknown paths", async () => {
				const result = await SharedUriHandler.handleUri("vscode://cline.cline/unknown?param=value")

				expect(result).to.be.false
				expect(handleTaskCreationStub.called).to.be.false
			})

			it("returns false for the removed sign-in and provider callbacks", async () => {
				for (const uri of [
					"vscode://cline.cline/auth?idToken=jwt123&provider=google",
					"vscode://cline.cline/auth/oca?code=abc&state=xyz",
					"vscode://cline.cline/openrouter?code=test123",
				]) {
					expect(await SharedUriHandler.handleUri(uri)).to.be.false
				}
				expect(handleTaskCreationStub.called).to.be.false
			})
		})

		describe("Error handling", () => {
			it("catches errors from controller methods", async () => {
				handleTaskCreationStub.rejects(new Error("Controller error"))

				const result = await SharedUriHandler.handleUri("vscode://cline.cline/task?prompt=hello")

				expect(result).to.be.false
			})

			it("handles malformed URIs gracefully", async () => {
				const result = await SharedUriHandler.handleUri("invalid://uri")

				expect(result).to.be.false
				expect(handleTaskCreationStub.called).to.be.false
			})
		})
	})
})

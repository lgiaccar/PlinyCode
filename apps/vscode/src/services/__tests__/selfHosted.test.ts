import { afterEach, describe, it } from "bun:test"
/**
 * Tests for selfHosted mode behavior across PostHog-based services.
 * When ClineEndpoint.isSelfHosted() returns true, all PostHog functionality should be disabled.
 */

import * as assert from "assert"
import * as sinon from "sinon"
import { ClineEndpoint } from "@/config"
import { ErrorProviderFactory } from "../error/ErrorProviderFactory"

describe("SelfHosted Mode - PostHog Disabling", () => {
	let isSelfHostedStub: sinon.SinonStub

	afterEach(() => {
		if (isSelfHostedStub) {
			isSelfHostedStub.restore()
		}
	})

	describe("ErrorProviderFactory", () => {
		it("should return no-op config when in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(true)

			const config = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "no-op", "Should return no-op type in selfHosted mode")
		})

		it("should return posthog config when NOT in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(false)

			const config = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "posthog", "Should return posthog type when not in selfHosted mode")
		})

		it("should create NoOp provider when in selfHosted mode", async () => {
			isSelfHostedStub = sinon.stub(ClineEndpoint, "isSelfHosted").returns(true)

			const config = ErrorProviderFactory.getDefaultConfig()
			const provider = await ErrorProviderFactory.createProvider(config)

			// NoOp provider should always be enabled
			assert.strictEqual(provider.isEnabled(), true, "NoOp provider should report as enabled")

			await provider.dispose()
		})
	})
})

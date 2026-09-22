// Under vitest, `@plinycode/core` is aliased to src/test/cline-core-vitest-stub.ts
// (see vitest.config.ts), which holds models.json state in memory and exposes
// the stub-only `resetModelsFileState` — hence the cast below.
import * as ClineCore from "@plinycode/core"
import { resetRegistry } from "@plinycode/llms"
import { beforeEach } from "vitest"

const { resetModelsFileState } = ClineCore as typeof ClineCore & { resetModelsFileState(): void }

beforeEach(() => {
	resetModelsFileState()
	// The stub's syncStoredProviderRegistration mutates the real shared
	// @plinycode/llms registry; reset it so registrations never leak across tests.
	resetRegistry()
})

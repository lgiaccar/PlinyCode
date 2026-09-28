import { EmptyRequest } from "@shared/proto/cline/common"
import { TestConnectionResult } from "@shared/proto/cline/state"
import { Controller } from ".."

/**
 * Reports that there is no OpenTelemetry connection to test: PlinyCode doesn't
 * export telemetry.
 */
export async function testOtelConnection(_controller: Controller, _: EmptyRequest): Promise<TestConnectionResult> {
	return TestConnectionResult.create({
		success: false,
		error: "OpenTelemetry export is not available in PlinyCode",
	})
}

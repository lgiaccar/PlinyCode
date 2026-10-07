/**
 * An error whose message is meant for the model. Tool handlers turn it into an
 * `isError` tool result, so the agent can read what went wrong and react.
 */
export class DevOpsError extends Error {
	constructor(
		message: string,
		/** The HTTP status, when an API answered with an error. */
		readonly status?: number,
	) {
		super(message)
		this.name = "DevOpsError"
	}
}

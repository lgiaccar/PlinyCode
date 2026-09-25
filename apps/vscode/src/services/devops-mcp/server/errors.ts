/**
 * An error whose message is meant for the model. Tool handlers turn it into an
 * `isError` tool result, so the agent can read what went wrong and react.
 */
export class DevOpsError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DevOpsError"
	}
}

/**
 * Signing in to an on-premises Azure DevOps Server (TFS), which accepts only
 * personal access tokens. The DevOps server process, the extension host and
 * the webview all use this: the error a provider raises names the host in a
 * fixed phrase, and the webview finds that phrase to offer a sign-in button.
 */

const SIGN_IN_PHRASE = /Azure DevOps Server (\S+) needs a personal access token\b/

/** The sentence an error carries when `host` needs (another) personal access token. */
export function adoServerSignInMessage(host: string): string {
	return `Azure DevOps Server ${host} needs a personal access token.`
}

/** The host named by an error from `adoServerSignInMessage`, or undefined. */
export function adoServerSignInHost(error: string | undefined): string | undefined {
	return error ? SIGN_IN_PHRASE.exec(error)?.[1] : undefined
}

/** Where a user creates a personal access token, given the collection URL (`https://host/tfs/Collection`). */
export function adoServerTokenPage(collectionUrl: string): string {
	return `${collectionUrl.replace(/\/+$/, "")}/_usersSettings/tokens`
}

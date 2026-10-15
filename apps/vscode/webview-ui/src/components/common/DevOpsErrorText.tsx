import { adoServerSignInHost } from "@shared/adoServerAuth"
import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { McpServiceClient } from "@/services/grpc-client"

/**
 * An error from the DevOps providers (CI Board, Pipelines). When it says an
 * Azure DevOps Server needs a personal access token, a button beside it asks
 * for one; `onSignedIn` then retries whatever failed.
 */
export function DevOpsErrorText({
	error,
	className,
	onSignedIn,
}: {
	error: string
	className?: string
	onSignedIn?: () => void
}) {
	const host = adoServerSignInHost(error)
	return (
		<div className={className} role="alert">
			{error}
			{host && <AdoServerSignInButton className="mt-1" host={host} onSignedIn={onSignedIn} />}
		</div>
	)
}

export function AdoServerSignInButton({
	host,
	className,
	onSignedIn,
	label = "Sign in to Azure DevOps Server",
}: {
	host?: string
	className?: string
	onSignedIn?: () => void
	label?: string
}) {
	const [busy, setBusy] = useState(false)
	const signIn = async () => {
		setBusy(true)
		try {
			const { value } = await McpServiceClient.signInAdoServer(StringRequest.create({ value: host ?? "" }))
			if (value) onSignedIn?.()
		} catch (error) {
			console.error("Azure DevOps Server sign-in failed:", error)
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className={cn("flex", className)}>
			<Button
				disabled={busy}
				onClick={(e) => {
					e.stopPropagation()
					void signIn()
				}}
				size="sm"
				title={
					host
						? `Paste a personal access token for ${host}`
						: "Paste a personal access token for an Azure DevOps Server"
				}
				variant="secondary">
				<span className="codicon codicon-key" />
				{label}
			</Button>
		</div>
	)
}

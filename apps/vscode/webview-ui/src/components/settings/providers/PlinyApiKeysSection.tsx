import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import type { PlinyApiKeys } from "@shared/proto/cline/models"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { invalidatePlinyBudget } from "@/hooks/usePlinyBudget"
import { ModelsServiceClient } from "@/services/grpc-client"

/** The stored Pliny API keys, kept current across windows; undefined until the extension has answered. */
function usePlinyApiKeys(): PlinyApiKeys | undefined {
	const [keys, setKeys] = useState<PlinyApiKeys>()
	const lastActiveId = useRef<string | undefined>(undefined)
	useEffect(() => {
		const unsubscribe = ModelsServiceClient.subscribeToPlinyApiKeys(EmptyRequest.create({}), {
			onResponse: (response: PlinyApiKeys) => {
				const activeId = response.keys.find((k) => k.active)?.id
				if (activeId !== lastActiveId.current) {
					// The budget shown is the active key's.
					lastActiveId.current = activeId
					invalidatePlinyBudget()
				}
				setKeys(response)
			},
			onError: (error: unknown) => console.error("Error in Pliny API keys subscription:", error),
			onComplete: () => {},
		})
		return unsubscribe
	}, [])
	return keys
}

function fallbackText(keys: PlinyApiKeys): string {
	if (keys.keys.length > 0) {
		return "Requests use the active key."
	}
	switch (keys.source) {
		case "providersFile":
			return "No key stored here: requests use the key saved in providers.json."
		case "environment":
			return "No key stored here: requests use the PLINY_API_KEY environment variable."
		default:
			return "No key yet: add one, or set the PLINY_API_KEY environment variable."
	}
}

/**
 * Pliny API keys: one or more, each with a name, stored in the OS keychain
 * by the extension. One is active; without any, the PLINY_API_KEY
 * environment variable is used. Keys are typed into VS Code's own input box,
 * so they never pass through this view.
 */
export const PlinyApiKeysSection = () => {
	const keys = usePlinyApiKeys()
	const [busy, setBusy] = useState(false)

	const run = async (action: () => Promise<unknown>) => {
		setBusy(true)
		try {
			await action()
		} catch (error) {
			console.error("Pliny API key action failed:", error)
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="mb-2.5" data-testid="pliny-api-keys">
			<div className="font-medium mb-1">Pliny API Keys</div>
			<p className="m-0 mb-2 text-sm text-description">
				Kept encrypted in the OS keychain and shared by every window. {keys ? fallbackText(keys) : ""}
				{keys && keys.keys.length > 0 && keys.envKeyPresent ? " PLINY_API_KEY is used only when no key is stored." : ""}
			</p>
			{keys && keys.keys.length > 0 && (
				<ul className="m-0 mb-2 p-0 list-none flex flex-col gap-1">
					{keys.keys.map((key) => (
						<li className="flex items-center gap-2" key={key.id}>
							<span className="codicon codicon-key text-description" />
							<span className="flex-1 min-w-0 truncate" title={key.name}>
								{key.name} <code className="text-description">••••{key.last4}</code>
							</span>
							{key.active ? (
								<span className="text-xs px-1.5 rounded bg-(--vscode-badge-background) text-(--vscode-badge-foreground)">
									Active
								</span>
							) : (
								<Button
									disabled={busy}
									onClick={() =>
										run(() =>
											ModelsServiceClient.setActivePlinyApiKey(StringRequest.create({ value: key.id })),
										)
									}
									size="xs"
									title={`Use "${key.name}" for requests`}
									variant="ghost">
									Use
								</Button>
							)}
							<Button
								disabled={busy}
								onClick={() =>
									run(() => ModelsServiceClient.renamePlinyApiKey(StringRequest.create({ value: key.id })))
								}
								size="xs"
								title={`Rename "${key.name}"`}
								variant="ghost">
								Rename
							</Button>
							<Button
								disabled={busy}
								onClick={() =>
									run(() => ModelsServiceClient.removePlinyApiKey(StringRequest.create({ value: key.id })))
								}
								size="xs"
								title={`Forget "${key.name}"`}
								variant="ghost">
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			<Button
				disabled={busy}
				onClick={() => run(() => ModelsServiceClient.addPlinyApiKey(EmptyRequest.create({})))}
				size="sm"
				variant="secondary">
				<span className="codicon codicon-add" /> Add Key
			</Button>
		</div>
	)
}

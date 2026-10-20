import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import {
	AddPlinyApiKeyRequest,
	type PlinyApiKeys,
	type PlinyApiKeyTestResult,
	RenamePlinyApiKeyRequest,
	TestPlinyApiKeyRequest,
} from "@shared/proto/cline/models"
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react"
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

/** A key test in flight, or its result. */
type TestState = "testing" | PlinyApiKeyTestResult

async function runTest(request: TestPlinyApiKeyRequest): Promise<PlinyApiKeyTestResult> {
	try {
		return await ModelsServiceClient.testPlinyApiKey(request)
	} catch (error) {
		return { ok: false, status: 0, message: `The test failed: ${String(error)}`, latencyMs: 0 }
	}
}

const inputClass =
	"w-full min-w-0 px-1.5 py-1 rounded-xs border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) text-(--vscode-input-foreground) placeholder:text-(--vscode-input-placeholderForeground) focus:outline-(--vscode-focusBorder)"

/** Grey before a test, a spinner while it runs, then green or red. */
const TestLight = ({ state }: { state: TestState | undefined }) => {
	if (state === "testing") {
		return <span aria-label="Testing the key" className="codicon codicon-loading codicon-modifier-spin text-description" />
	}
	const color = !state
		? "var(--vscode-descriptionForeground)"
		: state.ok
			? "var(--vscode-charts-green)"
			: "var(--vscode-charts-red)"
	const label = !state ? "Not tested" : state.ok ? "Key test passed" : "Key test failed"
	return (
		<span
			aria-label={label}
			className="inline-block shrink-0 size-2.5 rounded-full"
			role="img"
			style={{ background: color, opacity: state ? 1 : 0.5 }}
			title={state ? state.message : "Not tested yet: click Test"}
		/>
	)
}

const TestMessage = ({ state }: { state: TestState | undefined }) =>
	state && state !== "testing" ? (
		<p className="m-0 text-xs" style={{ color: state.ok ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)" }}>
			{state.message}
		</p>
	) : null

/** The inline form that adds a key: a nickname, the key, and Test / Save / Cancel. */
const AddKeyForm = ({ firstKey, onDone }: { firstKey: boolean; onDone: () => void }) => {
	const [name, setName] = useState(firstKey ? "Default" : "")
	const [key, setKey] = useState("")
	const [showKey, setShowKey] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState("")
	const [test, setTest] = useState<TestState>()
	const keyFieldId = useId()

	const canSave = name.trim() !== "" && key.trim() !== "" && !saving

	const save = async () => {
		if (!canSave) return
		setSaving(true)
		setError("")
		try {
			const result = await ModelsServiceClient.addPlinyApiKey(
				AddPlinyApiKeyRequest.create({ name: name.trim(), key: key.trim() }),
			)
			if (result.error) {
				setError(result.error)
			} else {
				setKey("")
				onDone()
			}
		} catch (failure) {
			setError(`The key could not be stored: ${String(failure)}`)
		} finally {
			setSaving(false)
		}
	}

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter") void save()
		if (event.key === "Escape") onDone()
	}

	return (
		<div className="mb-2 p-2 flex flex-col gap-1.5 rounded-xs border border-(--vscode-widget-border,transparent)">
			<label className="flex flex-col gap-0.5 text-sm">
				Nickname
				<input
					autoFocus
					className={inputClass}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="e.g. Personal, Team budget"
					value={name}
				/>
			</label>
			<div className="flex flex-col gap-0.5 text-sm">
				<label htmlFor={keyFieldId}>API key</label>
				<span className="flex items-center gap-1">
					<input
						autoComplete="off"
						className={inputClass}
						id={keyFieldId}
						onChange={(event) => {
							setKey(event.target.value)
							setTest(undefined)
						}}
						onKeyDown={onKeyDown}
						placeholder="Paste the Pliny API key"
						spellCheck={false}
						type={showKey ? "text" : "password"}
						value={key}
					/>
					<Button
						aria-label={showKey ? "Hide the key" : "Show the key"}
						onClick={() => setShowKey((shown) => !shown)}
						size="icon"
						title={showKey ? "Hide the key" : "Show the key"}
						variant="icon">
						<span className={`codicon ${showKey ? "codicon-eye-closed" : "codicon-eye"}`} />
					</Button>
				</span>
			</div>
			{error && (
				<p className="m-0 text-xs" style={{ color: "var(--vscode-errorForeground)" }}>
					{error}
				</p>
			)}
			<TestMessage state={test} />
			<div className="flex items-center gap-2">
				<TestLight state={test} />
				<Button
					disabled={!key.trim() || test === "testing"}
					onClick={async () => {
						setTest("testing")
						setTest(await runTest(TestPlinyApiKeyRequest.create({ key: key.trim() })))
					}}
					size="xs"
					title="Send a one-token request to the Pliny inference server with this key"
					variant="secondary">
					Test
				</Button>
				<span className="flex-1" />
				<Button disabled={saving} onClick={onDone} size="xs" variant="ghost">
					Cancel
				</Button>
				<Button disabled={!canSave} onClick={() => void save()} size="xs">
					{saving ? "Checking…" : "Save"}
				</Button>
			</div>
		</div>
	)
}

/** A row's nickname as a text field: Enter saves, Escape cancels. */
const RenameField = ({ id, name, onDone }: { id: string; name: string; onDone: () => void }) => {
	const [value, setValue] = useState(name)
	const [error, setError] = useState("")
	const save = async () => {
		if (value.trim() === name) {
			onDone()
			return
		}
		try {
			const result = await ModelsServiceClient.renamePlinyApiKey(
				RenamePlinyApiKeyRequest.create({ id, name: value.trim() }),
			)
			if (result.error) {
				setError(result.error)
			} else {
				onDone()
			}
		} catch (failure) {
			setError(`The key could not be renamed: ${String(failure)}`)
		}
	}
	return (
		<span className="flex-1 min-w-0 flex flex-col gap-0.5">
			<span className="flex items-center gap-1">
				<input
					aria-label={`New nickname for "${name}"`}
					autoFocus
					className={inputClass}
					onChange={(event) => {
						setValue(event.target.value)
						setError("")
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") void save()
						if (event.key === "Escape") onDone()
					}}
					value={value}
				/>
				<Button aria-label="Save the nickname" onClick={() => void save()} size="icon" title="Save" variant="icon">
					<span className="codicon codicon-check" />
				</Button>
				<Button aria-label="Cancel renaming" onClick={onDone} size="icon" title="Cancel" variant="icon">
					<span className="codicon codicon-close" />
				</Button>
			</span>
			{error && (
				<span className="text-xs" style={{ color: "var(--vscode-errorForeground)" }}>
					{error}
				</span>
			)}
		</span>
	)
}

/**
 * Pliny API keys: one or more, each with a nickname, stored in the OS keychain
 * by the extension. One is active; without any, the PLINY_API_KEY
 * environment variable is used. A key typed here goes to the extension once,
 * when it is tested or saved; the list only ever shows its last four characters.
 */
export const PlinyApiKeysSection = () => {
	const keys = usePlinyApiKeys()
	const [busy, setBusy] = useState(false)
	const [adding, setAdding] = useState(false)
	const [renaming, setRenaming] = useState<string>()
	const [tests, setTests] = useState<Record<string, TestState>>({})

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

	const testKey = async (id: string) => {
		setTests((current) => ({ ...current, [id]: "testing" }))
		const result = await runTest(TestPlinyApiKeyRequest.create({ id }))
		setTests((current) => ({ ...current, [id]: result }))
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
						<li className="flex flex-col gap-0.5" key={key.id}>
							<div className="flex items-center gap-2">
								<TestLight state={tests[key.id]} />
								{renaming === key.id ? (
									<RenameField id={key.id} name={key.name} onDone={() => setRenaming(undefined)} />
								) : (
									<span className="flex-1 min-w-0 truncate" title={key.name}>
										{key.name} <code className="text-description">••••{key.last4}</code>
									</span>
								)}
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
									disabled={tests[key.id] === "testing"}
									onClick={() => void testKey(key.id)}
									size="xs"
									title={`Check "${key.name}" against the Pliny inference server`}
									variant="ghost">
									Test
								</Button>
								{renaming !== key.id && (
									<Button
										disabled={busy}
										onClick={() => setRenaming(key.id)}
										size="xs"
										title={`Rename "${key.name}"`}
										variant="ghost">
										Rename
									</Button>
								)}
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
							</div>
							<div className="pl-4.5">
								<TestMessage state={tests[key.id]} />
							</div>
						</li>
					))}
				</ul>
			)}
			{adding ? (
				<AddKeyForm firstKey={!keys || keys.keys.length === 0} onDone={() => setAdding(false)} />
			) : (
				<Button disabled={busy} onClick={() => setAdding(true)} size="sm" variant="secondary">
					<span className="codicon codicon-add" /> Add Key
				</Button>
			)}
		</div>
	)
}

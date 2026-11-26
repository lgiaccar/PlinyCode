import { useEffect, useRef, useState } from "react"
/** Suggestions never own the draft; edits, dismissal and navigation invalidate pending replies. */
export function useNextPrompt(key: string | undefined, blocked: boolean, request: () => Promise<string>) {
	const [result, setResult] = useState<{ key: string; text: string }>()
	const dismissed = useRef(new Set<string>())
	const current = useRef({ key, blocked })
	if (current.current.key !== key && current.current.key) dismissed.current.add(current.current.key)
	current.current = { key, blocked }
	const dismiss = () => {
		if (key) dismissed.current.add(key)
		setResult(undefined)
	}
	useEffect(() => {
		let active = true
		if (!key) return
		if (blocked) {
			dismissed.current.add(key)
			return
		}
		if (dismissed.current.has(key)) return
		void request()
			.then((text) => {
				if (active && current.current.key === key && !current.current.blocked && !dismissed.current.has(key))
					setResult({ key, text })
			})
			.catch(() => {})
		return () => {
			active = false
		}
	}, [key, blocked, request])
	const text = !blocked && key && !dismissed.current.has(key) && result?.key === key ? result.text : ""
	return { text, dismiss }
}

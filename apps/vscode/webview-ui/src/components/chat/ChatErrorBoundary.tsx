import React from "react"

interface ChatErrorBoundaryProps {
	children: React.ReactNode
	errorTitle?: string
	errorBody?: string
	height?: string
	/** Renders instead of the default error box when a child throws. */
	fallback?: (error: Error) => React.ReactNode
	/**
	 * When any of these change (compared with Object.is) after an error, the
	 * boundary clears it and renders its children again, so content that threw
	 * on one update (a partial streaming row) can render on the next.
	 */
	resetKeys?: readonly unknown[]
}

interface ChatErrorBoundaryState {
	hasError: boolean
	error: Error | null
}

function keysChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
	if (previous === next) {
		return false
	}
	if (!previous || !next || previous.length !== next.length) {
		return true
	}
	return previous.some((key, index) => !Object.is(key, next[index]))
}

/**
 * A reusable error boundary component specifically designed for chat widgets.
 * It provides a consistent error UI with customizable title and body text.
 */
class ChatErrorBoundary extends React.Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
	constructor(props: ChatErrorBoundaryProps) {
		super(props)
		this.state = { hasError: false, error: null }
	}

	static getDerivedStateFromError(error: Error) {
		return { hasError: true, error }
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("Error in ChatErrorBoundary:", error.message)
		console.error("Component stack:", errorInfo.componentStack)
	}

	componentDidUpdate(previousProps: ChatErrorBoundaryProps) {
		if (this.state.hasError && keysChanged(previousProps.resetKeys, this.props.resetKeys)) {
			this.setState({ hasError: false, error: null })
		}
	}

	render() {
		const { errorTitle, errorBody, height, fallback } = this.props

		if (this.state.hasError) {
			if (fallback) {
				return fallback(this.state.error ?? new Error("Unknown error"))
			}
			return (
				<div
					style={{
						padding: "10px",
						color: "var(--vscode-errorForeground)",
						height: height || "auto",
						maxWidth: "512px",
						overflow: "auto",
						border: "1px solid var(--vscode-editorError-foreground)",
						borderRadius: "4px",
						backgroundColor: "var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1))",
					}}>
					<h3 style={{ margin: "0 0 8px 0" }}>{errorTitle || "Something went wrong displaying this content"}</h3>
					<p style={{ margin: "0" }}>{errorBody || `Error: ${this.state.error?.message || "Unknown error"}`}</p>
				</div>
			)
		}

		return this.props.children
	}
}

export default ChatErrorBoundary

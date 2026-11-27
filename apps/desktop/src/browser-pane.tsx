import { useCallback, useEffect, useRef, useState } from "react";
import type {
	EmbeddedBrowserCommand,
	EmbeddedBrowserState,
} from "./embedded-browser-contracts";

export function useBrowserPane() {
	const [state, setState] = useState<EmbeddedBrowserState>();
	const [error, setError] = useState("");
	const command = useCallback(async (command: EmbeddedBrowserCommand) => {
		try {
			setError("");
			const result = await window.plinycode.invoke({
				type: "embeddedBrowser",
				command,
			});
			if (result.embeddedBrowser) setState(result.embeddedBrowser);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	}, []);
	useEffect(() => {
		const unsubscribe = window.plinycode.subscribeBrowser(setState);
		void command({ operation: "status" });
		return unsubscribe;
	}, [command]);
	return { state, error, command };
}

export function BrowserPane({
	browser,
	covered,
	owner,
}: {
	browser: ReturnType<typeof useBrowserPane>;
	covered: boolean;
	owner?: string;
}) {
	const { state, command, error } = browser;
	const [address, setAddress] = useState("");
	const [width, setWidth] = useState(520);
	const viewport = useRef<HTMLDivElement>(null);
	useEffect(() => {
		setAddress(state?.url ?? "");
	}, [state?.url]);
	useEffect(() => {
		const element = viewport.current;
		const update = () => {
			const rect = element?.getBoundingClientRect();
			void window.plinycode
				.invoke({
					type: "embeddedBrowser",
					command: {
						operation: "bounds",
						x: rect?.x ?? 0,
						y: rect?.y ?? 0,
						width: rect?.width ?? 0,
						height: rect?.height ?? 0,
						visible: !!state?.visible && !covered,
					},
				})
				.catch(() => {});
		};
		const observer = new ResizeObserver(update);
		if (element) observer.observe(element);
		window.addEventListener("resize", update);
		update();
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [state?.visible, covered]);
	if (!state?.visible) return null;
	return (
		<aside className="browser-pane" aria-label="Browser" style={{ width }}>
			<div className="browser-heading">
				<strong title={state.title}>{state.title || "Browser"}</strong>
				<button
					type="button"
					aria-label="Close browser"
					onClick={() => command({ operation: "show", visible: false })}
				>
					Close
				</button>
			</div>
			<form
				className="browser-navigation"
				onSubmit={(event) => {
					event.preventDefault();
					const value = address.trim();
					void command({
						operation: "navigate",
						url: /^https?:\/\//i.test(value) ? value : `https://${value}`,
					});
				}}
			>
				<button
					type="button"
					aria-label="Browser back"
					disabled={!state.canGoBack}
					onClick={() => command({ operation: "back" })}
				>
					←
				</button>
				<button
					type="button"
					aria-label="Browser forward"
					disabled={!state.canGoForward}
					onClick={() => command({ operation: "forward" })}
				>
					→
				</button>
				<button
					type="button"
					aria-label={state.loading ? "Stop loading browser" : "Reload browser"}
					onClick={() =>
						command({ operation: state.loading ? "stop" : "reload" })
					}
				>
					{state.loading ? "Stop" : "↻"}
				</button>
				<input
					aria-label="Browser address"
					placeholder="https://example.com"
					value={address}
					onChange={(event) => setAddress(event.target.value)}
				/>
				<button type="submit">Go</button>
			</form>
			<div className="browser-controls">
				<output>
					{state.manual
						? "You have control"
						: owner
							? `Agent: ${owner}`
							: "Ready for agent"}
				</output>
				<button
					type="button"
					onClick={() =>
						command({ operation: state.manual ? "resume" : "takeover" })
					}
				>
					{state.manual ? "Allow agent" : "Take control"}
				</button>
				<label>
					Width{" "}
					<input
						aria-label="Browser width"
						type="range"
						min="320"
						max="1000"
						step="20"
						value={width}
						onChange={(event) => setWidth(Number(event.target.value))}
					/>
				</label>
			</div>
			{(error || state.error) && (
				<div className="browser-error" role="alert">
					{error || state.error}
				</div>
			)}
			<div className="browser-viewport" ref={viewport}>
				{!state.url && (
					<p>
						Open a website here, or ask PlinyCode to browse.
						<br />
						This browser has its own session.
					</p>
				)}
			</div>
		</aside>
	);
}

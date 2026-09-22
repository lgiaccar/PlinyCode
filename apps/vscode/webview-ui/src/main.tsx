import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./main.css"
import "./index.css"
import App from "./App.tsx"

// VS Code does not inject --vscode-colorScheme. Native <select>/<option> and
// datetime controls use the page color-scheme; without it they render a light
// OS popup over dark-theme text. Derive light/dark from editor background and
// refresh when workbench CSS variables change (theme switch).
function syncColorSchemeFromTheme() {
	try {
		const tempEl = document.createElement("div")
		tempEl.style.backgroundColor = "var(--vscode-editor-background)"
		tempEl.style.position = "absolute"
		tempEl.style.visibility = "hidden"
		document.body.appendChild(tempEl)
		const computedBg = getComputedStyle(tempEl).backgroundColor
		document.body.removeChild(tempEl)
		const parts = computedBg.match(/[\d.]+/g)
		if (parts && parts.length >= 3) {
			const [r, g, b] = parts.map(Number)
			const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255
			document.documentElement.style.colorScheme = brightness < 0.5 ? "dark" : "light"
			return
		}
	} catch {
		// fall through
	}
	document.documentElement.style.colorScheme = "dark"
}

syncColorSchemeFromTheme()
const themeObserver = new MutationObserver(syncColorSchemeFromTheme)
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] })
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] })

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)

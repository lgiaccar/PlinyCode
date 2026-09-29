import styled from "styled-components"

/**
 * Container for dropdowns that ensures proper z-index handling
 * This is necessary to ensure dropdown opens downward
 */
export const DropdownContainer = styled.div.attrs<{ zIndex?: number }>(({ zIndex }) => ({
	style: {
		zIndex: zIndex || 1000,
	},
}))`
	position: relative;

	// Force dropdowns to open downward
	& vscode-dropdown::part(listbox) {
		position: absolute !important;
		top: 100% !important;
		bottom: auto !important;
	}
`

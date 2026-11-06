import type React from "react"
import styled from "styled-components"
import { MIN_CONVERSATION_CSS } from "@/components/chat/chat-textarea/hooks/useResizableRows"
import { useExtensionState } from "@/context/ExtensionStateContext"

interface ChatLayoutProps {
	isHidden: boolean
	children: React.ReactNode
}

/**
 * Main layout container for the chat view: the conversation on top, the
 * footer with the prompt box below. The conversation keeps a minimum height
 * however tall the footer gets; the prompt box caps itself to match (see
 * `useFittingRows`), so neither can cover the other.
 *
 * Sets `--plinycode-chat-font-size` on the container so message body text
 * can inherit it (controlled by `plinycode.chat.fontSize` in VS Code settings).
 */
export const ChatLayout: React.FC<ChatLayoutProps> = ({ isHidden, children }) => {
	const { chatFontSize } = useExtensionState()
	const fontSize = chatFontSize ?? 13

	return (
		<ChatLayoutContainer isHidden={isHidden} style={{ "--plinycode-chat-font-size": `${fontSize}px` } as React.CSSProperties}>
			<MainContent>{children}</MainContent>
		</ChatLayoutContainer>
	)
}

const ChatLayoutContainer = styled.div.withConfig({
	shouldForwardProp: (prop) => !["isHidden"].includes(prop),
})<{ isHidden: boolean }>`
	display: ${(props) => (props.isHidden ? "none" : "grid")};
	grid-template-rows: minmax(${MIN_CONVERSATION_CSS}, 1fr) auto;
	overflow: hidden;
	padding: 0;
	margin: 0;
	width: 100%;
	height: 100%;
	min-height: 100vh;
	position: relative;
	font-size: var(--plinycode-chat-font-size, 13px);
`

const MainContent = styled.div`
	display: flex;
	flex-direction: column;
	overflow: hidden;
	grid-row: 1;
`

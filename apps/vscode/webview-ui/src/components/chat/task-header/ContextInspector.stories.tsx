import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { ContextInspector } from "./ContextInspector"

function Preview() {
	const [ready, setReady] = useState(false)
	useEffect(() => {
		const old = TaskServiceClient.inspectContext
		TaskServiceClient.inspectContext = async () => ({
			value: JSON.stringify({
				omittedRequests: 10,
				requests: [
					{
						id: 11,
						at: Date.now() - 60000,
						modelId: "pliny/auto-free",
						estimatedTokens: 52600,
						notices: ["Captured before provider conversion; token counts are estimates."],
						sections: [
							{
								label: "Conversation · user · message-11",
								content: "Make the CI Board easier to scan.",
								partial: false,
							},
						],
					},
					{
						id: 12,
						at: Date.now(),
						modelId: "pliny/auto-free",
						estimatedTokens: 24600,
						notices: [
							"Captured before provider conversion and router selection.",
							"Some previews are shortened. The sent request was not shortened by the inspector.",
							"The engine does not enumerate every excluded source here.",
						],
						sections: [
							{
								label: "Rules",
								content: "Use Bun. Keep the product name PlinyCode. Preserve existing approval rules.",
								partial: false,
							},
							{
								label: "Memory",
								content: "The CI Board must show the exact checked head and expired validations.",
								partial: false,
							},
							{
								label: "Conversation · summary · user · message-12",
								content: "The compact chat header is approved. Continue improving the CI Board.",
								partial: false,
							},
							{
								label: "Tool results · read_files · user · message-13",
								content: "export function matchesCiStatus(item, filter) { /* captured source preview */ }",
								partial: true,
							},
							{
								label: "Tool definitions · read_files",
								content: '{"name":"read_files","description":"Read file contents"}',
								partial: false,
							},
						],
					},
				],
			}),
		})
		setReady(true)
		return () => {
			TaskServiceClient.inspectContext = old
		}
	}, [])
	return ready ? <ContextInspector onClose={() => setReady(false)} taskId="preview" /> : null
}
export default { title: "PlinyCode/Context inspector", component: Preview } satisfies Meta<typeof Preview>
export const Requests: StoryObj<typeof Preview> = {}

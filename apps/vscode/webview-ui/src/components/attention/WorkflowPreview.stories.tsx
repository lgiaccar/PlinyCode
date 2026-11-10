import { CiBoardState, CiItem, CiTargetView } from "@shared/proto/cline/ci_board"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { DeliveryCard } from "@/components/chat/DeliveryCard"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { CiBoardServiceClient, TaskServiceClient } from "@/services/grpc-client"
import { AttentionInbox } from "./AttentionInbox"

function Preview({ view }: { view: "delivery" | "attention" }) {
	const [ready, setReady] = useState(false)
	useEffect(() => {
		const oldDelivery = TaskServiceClient.getDeliveryEvidence
		const oldAttention = TaskServiceClient.manageAttention
		const oldBoard = CiBoardServiceClient.subscribeToCiBoard
		TaskServiceClient.getDeliveryEvidence = async () => ({
			value: JSON.stringify({
				evidence: [
					{
						id: "1",
						category: "checks",
						tool: "run_commands",
						input: "bun run test:unit",
						output: "48 pass\n0 fail",
						failed: false,
					},
				],
				omitted: 0,
				remote: {
					branch: "lgiaccar/delivery-card",
					checkedAt: Date.now(),
					pr: { id: 42, state: "merged", head: "abc123456789", url: "https://example.com/pr/42" },
					checks: [{ name: "Quality Checks", status: "completed", result: "success" }],
				},
			}),
		})
		TaskServiceClient.manageAttention = async () => ({
			value: JSON.stringify({
				workspace: "/preview",
				omitted: 0,
				tasks: [
					{ id: "a", title: "Verify CI Board changes", updatedAt: Date.now(), status: "approval" },
					{ id: "b", title: "Choose the default CI view", updatedAt: Date.now(), status: "question" },
					{ id: "c", title: "Make the chat header compact", updatedAt: Date.now(), status: "review" },
				],
			}),
		})
		CiBoardServiceClient.subscribeToCiBoard = (_request, callbacks) => {
			callbacks.onResponse(
				CiBoardState.create({
					targets: [
						CiTargetView.create({
							id: "repo",
							label: "PlinyCode",
							items: [
								CiItem.create({
									key: "ci",
									title: "Simplify model routing",
									prId: 43,
									pipelines: [{ name: "Windows tests", color: "red", status: "completed", result: "failure" }],
								}),
							],
						}),
					],
				}),
			)
			return () => {}
		}
		setReady(true)
		return () => {
			TaskServiceClient.getDeliveryEvidence = oldDelivery
			TaskServiceClient.manageAttention = oldAttention
			CiBoardServiceClient.subscribeToCiBoard = oldBoard
		}
	}, [])
	return ready ? view === "delivery" ? <DeliveryCard /> : <AttentionInbox onClose={() => setReady(false)} /> : null
}

export default {
	title: "PlinyCode/Workflow previews",
	component: Preview,
	decorators: [
		createStorybookDecorator({
			currentTaskItem: { id: "preview", task: "Preview", ts: 1, tokensIn: 0, tokensOut: 0, totalCost: 0 },
		}),
	],
} satisfies Meta<typeof Preview>
type Story = StoryObj<typeof Preview>
export const Delivery: Story = { args: { view: "delivery" } }
export const Attention: Story = { args: { view: "attention" } }

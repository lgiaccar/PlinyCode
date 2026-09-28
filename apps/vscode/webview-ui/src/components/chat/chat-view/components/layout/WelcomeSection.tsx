import React from "react"
import PlinyBudgetIndicator from "@/components/common/PlinyBudgetIndicator"
import HistoryPreview from "@/components/history/HistoryPreview"
import HomeHeader from "@/components/welcome/HomeHeader"
import { WelcomeSectionProps } from "../../types/chatTypes"

/**
 * Welcome section shown when there's no active task
 * Includes the home header, budget indicator and history preview
 */
export const WelcomeSection: React.FC<WelcomeSectionProps> = ({ showHistoryView, taskHistory }) => {
	return (
		<div className="flex flex-col flex-1 w-full h-full p-0 m-0">
			<div className="overflow-y-auto flex flex-col pb-2.5">
				<HomeHeader />
				<PlinyBudgetIndicator className="self-center mb-2" />
				{taskHistory.length > 0 && <HistoryPreview showHistoryView={showHistoryView} />}
			</div>
		</div>
	)
}

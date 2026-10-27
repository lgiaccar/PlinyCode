import { EmptyRequest } from "@shared/proto/cline/common"
import ClineLogoSanta from "@/assets/ClineLogoSanta"
import ClineLogoVariable from "@/assets/ClineLogoVariable"
import PlinyCodeLogo from "@/assets/PlinyCodeLogo"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

const HomeHeader = () => {
	const { environment } = useExtensionState()

	const handleTakeATour = async () => {
		try {
			await UiServiceClient.openWalkthrough(EmptyRequest.create())
		} catch (error) {
			console.error("Error opening walkthrough:", error)
		}
	}

	const isDecember = new Date().getMonth() === 11 // 11 = December (0-indexed)
	const LogoComponent = isDecember ? ClineLogoSanta : ClineLogoVariable
	const headingText = "AI, Code & Rock 'n' Roll"
	const showEnvironmentMark = isDecember || environment === "local" || environment === "staging"

	return (
		<div className="flex flex-col items-center mb-5">
			{showEnvironmentMark ? (
				<>
					<div className="my-7">
						<LogoComponent className="size-20" environment={environment} />
					</div>
					<h1 className="m-0 font-bold text-center px-4">{headingText}</h1>
				</>
			) : (
				<div className="my-7 w-full px-4 flex justify-center">
					<h1 className="sr-only">PlinyCode — {headingText}</h1>
					<PlinyCodeLogo />
				</div>
			)}
			<div className="mt-4">
				<button
					className="flex items-center gap-2 px-4 py-2 rounded-full border border-border-panel bg-white/2 hover:bg-list-background-hover transition-colors duration-150 ease-in-out text-code-foreground text-sm font-medium cursor-pointer"
					onClick={handleTakeATour}
					type="button">
					Take a Tour
					<span className="codicon codicon-play scale-90" />
				</button>
			</div>
		</div>
	)
}

export default HomeHeader

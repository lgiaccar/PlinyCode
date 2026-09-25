import { EmptyRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface AboutSectionProps {
	version: string
	extensionVariant?: "legacy" | "next"
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const VARIANT_LABELS: Record<"legacy" | "next", string> = {
	legacy: "Legacy",
	next: "Next",
}

const AboutSection = ({ version, extensionVariant, renderSectionHeader }: AboutSectionProps) => {
	const { prereleaseUpdatesEnabled } = useExtensionState()

	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<h2 className="text-lg font-semibold">
						PlinyCode v{version}
						{extensionVariant && (
							<span className="ml-2 text-sm font-normal text-description">
								({VARIANT_LABELS[extensionVariant]})
							</span>
						)}
					</h2>
					<p>
						An AI assistant that can use your CLI and Editor. PlinyCode can handle complex software development tasks
						step-by-step with tools that let him create & edit files, explore large projects, use the browser, and
						execute terminal commands (after you grant permission).
					</p>

					<h3 className="text-md font-semibold">Updates</h3>
					<div>
						<VSCodeButton
							appearance="secondary"
							onClick={() =>
								UiServiceClient.checkForUpdates(EmptyRequest.create()).catch((error) =>
									console.error("Failed to check for updates:", error),
								)
							}>
							Check for Updates
						</VSCodeButton>
						<p className="text-sm mt-[5px] text-description">
							PlinyCode also checks GitHub automatically at startup and every 6 hours.
						</p>
					</div>
					<div>
						<VSCodeCheckbox
							checked={!!prereleaseUpdatesEnabled}
							onChange={(e: any) => updateSetting("prereleaseUpdatesEnabled", e.target.checked === true)}>
							Install pre-releases (developers and testers)
						</VSCodeCheckbox>
						<p className="text-sm mt-[5px] text-description">
							Also install test builds such as 0.1.4-test.1 as soon as they are published. Leave off to get official
							releases only. Turning this off keeps your current build until a newer official release replaces it.
						</p>
					</div>

					<h3 className="text-md font-semibold">Community & Support</h3>
					<p>
						<VSCodeLink href="https://x.com/cline">X</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://discord.gg/cline">Discord</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://www.reddit.com/r/cline/"> r/cline</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">Development</h3>
					<p>
						<VSCodeLink href="https://github.com/cline/cline">GitHub</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/cline/cline/issues"> Issues</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/cline/cline/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop">
							{" "}
							Feature Requests
						</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">Resources</h3>
					<p>
						<VSCodeLink href="https://docs.cline.bot/">Documentation</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://cline.bot/">https://cline.bot</VSCodeLink>
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection

import PreferredLanguageSetting from "../PreferredLanguageSetting"
import Section from "../Section"
import SpendingLimitSetting from "../SpendingLimitSetting"
import WaitLimitSetting from "../WaitLimitSetting"

interface GeneralSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const GeneralSettingsSection = ({ renderSectionHeader }: GeneralSettingsSectionProps) => {
	return (
		<div>
			{renderSectionHeader("general")}
			<Section>
				<PreferredLanguageSetting />

				<SpendingLimitSetting />
				<WaitLimitSetting />
			</Section>
		</div>
	)
}

export default GeneralSettingsSection

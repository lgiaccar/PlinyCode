import PreferredLanguageSetting from "../PreferredLanguageSetting"
import Section from "../Section"
import SpendingLimitSetting from "../SpendingLimitSetting"

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
			</Section>
		</div>
	)
}

export default GeneralSettingsSection

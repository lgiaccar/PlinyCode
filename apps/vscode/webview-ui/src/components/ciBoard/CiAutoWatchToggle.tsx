import { useId } from "react"
import { Switch } from "@/components/ui/switch"
import { CiTip } from "./CiTip"
import { AUTO_WATCH_TIP } from "./ciBoardUtils"

/** The target's auto-watch switch. */
export const CiAutoWatchToggle = ({
	checked,
	disabledReason,
	onChange,
}: {
	checked: boolean
	disabledReason?: string
	onChange: (checked: boolean) => void
}) => {
	const id = useId()
	return (
		<CiTip tip={disabledReason ? `${AUTO_WATCH_TIP} ${disabledReason}` : AUTO_WATCH_TIP}>
			<span className="inline-flex items-center gap-1 text-xs text-description flex-shrink-0">
				<Switch
					checked={checked}
					data-testid="ci-auto-watch"
					disabled={!!disabledReason && !checked}
					id={id}
					onCheckedChange={onChange}
				/>
				<label className="cursor-pointer" htmlFor={id}>
					Auto-watch
				</label>
			</span>
		</CiTip>
	)
}

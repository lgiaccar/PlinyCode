import type { ReactElement, ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * The CI board's tooltip. A disabled button gets no pointer events, so
 * `wrap` puts the trigger on a span around it to still explain why.
 */
export const CiTip = ({
	tip,
	side = "top",
	wrap = false,
	children,
}: {
	tip?: ReactNode
	side?: "top" | "bottom" | "left" | "right"
	wrap?: boolean
	children: ReactElement
}) => {
	if (!tip) return children
	return (
		<Tooltip>
			<TooltipTrigger asChild>{wrap ? <span className="inline-flex">{children}</span> : children}</TooltipTrigger>
			<TooltipContent className="max-w-xs" side={side}>
				{tip}
			</TooltipContent>
		</Tooltip>
	)
}

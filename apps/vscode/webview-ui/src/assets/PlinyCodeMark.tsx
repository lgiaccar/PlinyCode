import type { SVGProps } from "react"
import robotColor from "./plinycode-robot-color.png"

/** Robot mascot with a theme-aware vector silhouette for compact UI surfaces. */
const PlinyCodeMark = ({
	fullColor = false,
	fill = "currentColor",
	...props
}: SVGProps<SVGSVGElement> & { fullColor?: boolean }) => (
	<svg fill="none" height="50" role="img" viewBox="0 0 32 32" width="50" xmlns="http://www.w3.org/2000/svg" {...props}>
		<title>PlinyCode</title>
		{fullColor ? (
			<image height="32" href={robotColor} width="32" />
		) : (
			<g fill={fill}>
				<path d="M10 11H22Q28 11 28 17V25Q28 29 22 29H10Q4 29 4 25V17Q4 11 10 11Z M10 14Q7 14 7 17V24Q7 26 10 26H22Q25 26 25 24V17Q25 14 22 14Z" />
				<path d="M12 16L9 19L12 22L13.4 20.6L11.8 19L13.4 17.4Z" />
				<path d="M20 16L23 19L20 22L18.6 20.6L20.2 19L18.6 17.4Z" />
				<path d="M11 23Q16 27 21 23Q16 24.6 11 23Z" />
				<path d="M4 16C-.5 16 -.5 25 4 25V23C2 23 2 18 4 18Z" />
				<path d="M28 16C32.5 16 32.5 25 28 25V23C30 23 30 18 28 18Z" />
				<path d="M5.3 12V8H6.7V12Z M25.3 12V8H26.7V12Z" />
				<path d="M7.2 7.2A1.2 1.2 0 1 1 4.8 7.2A1.2 1.2 0 1 1 7.2 7.2Z M27.2 7.2A1.2 1.2 0 1 1 24.8 7.2A1.2 1.2 0 1 1 27.2 7.2Z" />
				<path d="M12 11L21.5 0.8L19.8 6.9L24 5L18.5 14L16 10.4L13.3 11.9Z" />
				<path d="M11 29.6H21V31.2H11Z" />
			</g>
		)}
	</svg>
)
export default PlinyCodeMark

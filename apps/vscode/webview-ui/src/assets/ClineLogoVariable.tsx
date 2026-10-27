import type { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../utils/environmentColors"
import PlinyCodeMark from "./PlinyCodeMark"

const ClineLogoVariable = ({ environment, ...props }: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const isDevelopment = environment === "local" || environment === "staging"
	return <PlinyCodeMark fill={getEnvironmentColor(environment)} fullColor={!isDevelopment} {...props} />
}
export default ClineLogoVariable

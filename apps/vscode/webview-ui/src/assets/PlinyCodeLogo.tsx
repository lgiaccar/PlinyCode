import "./PlinyCodeLogo.css"
import logoDark from "./plinycode-logo-dark.png"
import logoLight from "./plinycode-logo-light.png"

const PlinyCodeLogo = () => (
	<div aria-label="PlinyCode — AI, Code & Rock ’n’ Roll" className="plinycode-brand-logo" role="img">
		<img alt="" aria-hidden="true" className="plinycode-brand-logo-light" src={logoLight} />
		<img alt="" aria-hidden="true" className="plinycode-brand-logo-dark" src={logoDark} />
	</div>
)
export default PlinyCodeLogo

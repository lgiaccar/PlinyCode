import { version } from "../package.json";

declare const PLINYCODE_CLI_VERSION: string;
export const CLI_VERSION =
	typeof PLINYCODE_CLI_VERSION === "string" ? PLINYCODE_CLI_VERSION : version;

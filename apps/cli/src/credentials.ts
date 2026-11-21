import {
	getPlinyApiKey,
	PlinyCredentialError,
	removePlinyApiKey,
	savePlinyApiKey,
} from "@plinycode/shared/node";
import { CliError } from "./options";

async function credentialCall<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof PlinyCredentialError)
			throw new CliError(error.code, error.message, error.exitCode);
		throw error;
	}
}
export const getApiKey = () => credentialCall(getPlinyApiKey);
export const saveApiKey = (key: string) =>
	credentialCall(() => savePlinyApiKey(key));
export const removeApiKey = () => credentialCall(removePlinyApiKey);

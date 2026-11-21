import { redact } from "./redaction";

// Opt-in process-local policy. Desktop uses one process per task; other hosts
// retain their existing persistence behavior unless they explicitly opt in.
// Engine bundles can contain their own copy of shared utilities. A symbol key
// keeps the host's opt-in policy consistent across those copies in one process.
const key = Symbol.for("plinycode.artifactRedaction.secrets");
const processState = globalThis as unknown as Record<
	symbol,
	string[] | undefined
>;
export function configureArtifactRedaction(secrets: readonly string[]): void {
	processState[key] = [...new Set(secrets.filter(Boolean))];
}
export function redactArtifactText(text: string): string {
	const artifactSecrets = processState[key] ?? [];
	if (!artifactSecrets.length) return text;
	return redact(
		text,
		artifactSecrets.flatMap((secret) => [
			secret,
			JSON.stringify(secret).slice(1, -1),
		]),
	);
}
export function serializeArtifact(value: unknown, indent?: number): string {
	return JSON.stringify(
		value,
		(_key, item) =>
			typeof item === "string" ? redactArtifactText(item) : item,
		indent,
	);
}

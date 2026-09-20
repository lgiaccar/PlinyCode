/**
 * One-shot Pliny connectivity smoke test. Does not print the API key.
 * Usage: node --use-system-ca research/probes/smoke.js
 */
const key = process.env.PLINY_API_KEY;
if (!key) {
	console.error("PLINY_API_KEY is not set");
	process.exit(1);
}

const res = await fetch(
	"https://snps-inference.internal.synopsys.com/api/llm/chat/completions",
	{
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
			"X-TFY-METADATA": "{}",
			"X-TFY-LOGGING-CONFIG": '{"enabled": true}',
		},
		body: JSON.stringify({
			model: "snps-aws-bedrock/aws-claude-sonnet-4.6",
			messages: [{ role: "user", content: "Reply with exactly: pliny-ok" }],
			max_tokens: 32,
		}),
	},
);

const text = await res.text();
console.log("status", res.status);
console.log(text.slice(0, 500));
process.exit(res.ok ? 0 : 1);

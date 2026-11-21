import { strict as assert } from "node:assert";
import {
	getPlinyApiKey,
	removePlinyApiKey,
	savePlinyApiKey,
} from "@plinycode/shared/node";

assert.equal(process.platform, "linux");
assert.equal(
	process.env.PLINY_TEST_SESSION,
	"1",
	"Use the disposable test session",
);
delete process.env.PLINY_API_KEY;
const secret = "isolated-linux-keyring-fixture";
try {
	await savePlinyApiKey(secret);
	assert.equal(await getPlinyApiKey(), secret);
	const lookup = Bun.spawn(
		["secret-tool", "lookup", "service", "plinycode-cli", "account", "pliny"],
		{ stdout: "pipe" },
	);
	assert.equal((await new Response(lookup.stdout).text()).trim(), secret);
	assert.equal(await lookup.exited, 0);
	process.env.PLINY_API_KEY = "injected-fixture";
	assert.equal(await getPlinyApiKey(), "injected-fixture");
} finally {
	delete process.env.PLINY_API_KEY;
	await removePlinyApiKey();
}
await assert.rejects(getPlinyApiKey);
console.log(
	"PASS: native Secret Service credential roundtrip, CLI sharing, environment override and removal",
);

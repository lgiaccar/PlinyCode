import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionService } from "../../session/services/file-session-service";

const sqliteInitMock = vi.hoisted(() => vi.fn());

vi.mock("../../services/storage/sqlite-session-store", () => ({
	SqliteSessionStore: class {
		init(): void {
			sqliteInitMock();
		}
	},
}));

describe("runtime host resolution", () => {
	afterEach(() => {
		sqliteInitMock.mockReset();
		vi.resetModules();
	});

	it("uses sqlite session storage when it initializes", async () => {
		const { resolveSessionBackend } = await import("./host");

		const backend = await resolveSessionBackend({});

		expect(backend).not.toBeInstanceOf(FileSessionService);
	});

	it("falls back to file session storage when sqlite initialization fails", async () => {
		sqliteInitMock.mockImplementation(() => {
			throw new Error("sqlite unavailable");
		});
		const { resolveSessionBackend } = await import("./host");

		const backend = await resolveSessionBackend({});
		expect(backend.constructor.name).toBe("FileSessionService");
	});

	it("silently falls back to file session storage when node:sqlite is unavailable", async () => {
		sqliteInitMock.mockImplementation(() => {
			const error = new Error(
				"No such built-in module: node:sqlite",
			) as Error & {
				code?: string;
			};
			error.code = "ERR_UNKNOWN_BUILTIN_MODULE";
			throw error;
		});
		const { resolveSessionBackend } = await import("./host");

		const backend = await resolveSessionBackend({});
		expect(backend.constructor.name).toBe("FileSessionService");
	});

	it("creates a local runtime host", async () => {
		const { createRuntimeHost } = await import("./host");
		const { LocalRuntimeHost } = await import("./local-runtime-host");

		const host = await createRuntimeHost({});

		expect(host).toBeInstanceOf(LocalRuntimeHost);
	});
});

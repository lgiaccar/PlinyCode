import { describe, expect, it } from "vitest"
import type * as vscode from "vscode"
import { PlinyApiKeys } from "./pliny-api-keys"

/** SecretStorage in memory, with the change event VS Code fires in every window. */
function fakeSecrets() {
	const values = new Map<string, string>()
	const listeners = new Set<(event: { key: string }) => void>()
	const fire = (key: string) => {
		for (const listener of listeners) listener({ key })
	}
	const secrets = {
		get: async (key: string) => values.get(key),
		store: async (key: string, value: string) => {
			values.set(key, value)
			fire(key)
		},
		delete: async (key: string) => {
			values.delete(key)
			fire(key)
		},
		keys: async () => [...values.keys()],
		onDidChange: (listener: (event: { key: string }) => void) => {
			listeners.add(listener)
			return { dispose: () => listeners.delete(listener) }
		},
	}
	return { secrets: secrets as unknown as vscode.SecretStorage, values }
}

describe("PlinyApiKeys", () => {
	it("makes the first key active, keeps only the last four characters in the list and the key in its own secret", async () => {
		const { secrets, values } = fakeSecrets()
		const keys = new PlinyApiKeys(secrets)
		await keys.ready
		expect(keys.activeKey()).toBeUndefined()

		const personal = await keys.add(" Personal ", "test-key-0001")
		await keys.add("Team", "test-key-0002")

		expect(keys.activeKey()).toBe("test-key-0001")
		expect(keys.list().map((k) => [k.name, k.last4, k.id === keys.activeId()])).toEqual([
			["Personal", "0001", true],
			["Team", "0002", false],
		])
		expect(values.get(`plinycode.plinyApiKey:${personal.id}`)).toBe("test-key-0001")
		expect(values.get("plinycode.plinyApiKeys")).not.toContain("test-key")
	})

	it("switches, renames and, removing the active key, activates the next one", async () => {
		const { secrets, values } = fakeSecrets()
		const keys = new PlinyApiKeys(secrets)
		const a = await keys.add("A", "test-key-000a")
		const b = await keys.add("B", "test-key-000b")
		const c = await keys.add("C", "test-key-000c")

		await keys.setActive(b.id)
		expect(keys.activeKey()).toBe("test-key-000b")
		await keys.rename(b.id, "Budget")
		expect(keys.list().find((k) => k.id === b.id)?.name).toBe("Budget")

		await keys.remove(b.id)
		expect(keys.activeId()).toBe(c.id)
		expect(keys.activeKey()).toBe("test-key-000c")
		expect(values.has(`plinycode.plinyApiKey:${b.id}`)).toBe(false)

		await keys.remove(c.id)
		expect(keys.activeId()).toBe(a.id)
		await keys.remove(a.id)
		expect(keys.activeKey()).toBeUndefined()
		expect(keys.list()).toEqual([])
	})

	it("offers the next key after the active one, wrapping round and skipping excluded ones", async () => {
		const { secrets } = fakeSecrets()
		const keys = new PlinyApiKeys(secrets)
		const a = await keys.add("A", "test-key-000a")
		const b = await keys.add("B", "test-key-000b")
		const c = await keys.add("C", "test-key-000c")

		expect(keys.nextAfter(a.id)?.id).toBe(b.id)
		expect(keys.nextAfter(c.id)?.id).toBe(a.id)
		expect(keys.nextAfter(a.id, new Set([a.id, b.id]))?.id).toBe(c.id)
		expect(keys.nextAfter(a.id, new Set([b.id, c.id]))).toBeUndefined()
		expect(await keys.findByValue("test-key-000b")).toMatchObject({ id: b.id })
		expect(await keys.findByValue("test-key-other")).toBeUndefined()
	})

	it("sees another window's change and tells its listeners", async () => {
		const { secrets } = fakeSecrets()
		const here = new PlinyApiKeys(secrets)
		const there = new PlinyApiKeys(secrets)
		await Promise.all([here.ready, there.ready])
		let changes = 0
		here.onDidChange(() => changes++)

		const b = await there.add("A", "test-key-000a").then(() => there.add("B", "test-key-000b"))
		await there.setActive(b.id)
		// The change event reloads asynchronously.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(here.activeKey()).toBe("test-key-000b")
		expect(changes).toBeGreaterThan(0)
	})

	it("reads a damaged index as no keys, and an unknown active id as the first key", async () => {
		const damaged = fakeSecrets()
		damaged.values.set("plinycode.plinyApiKeys", "{not json")
		const none = new PlinyApiKeys(damaged.secrets)
		await none.ready
		expect(none.list()).toEqual([])

		const stale = fakeSecrets()
		stale.values.set(
			"plinycode.plinyApiKeys",
			JSON.stringify({ activeId: "gone", keys: [{ id: "k1", name: "A", last4: "000a", createdAt: 1 }, { id: 7 }] }),
		)
		stale.values.set("plinycode.plinyApiKey:k1", "test-key-000a")
		const keys = new PlinyApiKeys(stale.secrets)
		await keys.ready
		expect(keys.list().map((k) => k.id)).toEqual(["k1"])
		expect(keys.activeKey()).toBe("test-key-000a")
	})
})

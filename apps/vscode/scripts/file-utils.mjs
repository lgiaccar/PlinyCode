import * as fs from "fs/promises"
import * as path from "path"

/**
 * Write generated content only when it changes. Replacing the file in one rename
 * keeps live extension and webview watchers from reading a half-written output.
 */
export async function writeFileWithMkdirs(filePath, content) {
	const next = Buffer.isBuffer(content) ? content : Buffer.from(content)
	try {
		const current = await fs.readFile(filePath)
		if (current.equals(next)) return false
	} catch (error) {
		if (error.code !== "ENOENT") throw error
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
	try {
		await fs.writeFile(temporaryPath, next)
		await fs.rename(temporaryPath, filePath)
	} finally {
		await fs.rm(temporaryPath, { force: true })
	}
	return true
}

export async function rmrf(path) {
	await fs.rm(path, { force: true, recursive: true })
}

/**
 * Remove an empty dir, do nothing if the directory doesn't exist or is not empty.
 */
export async function rmdir(path) {
	try {
		await fs.rmdir(path)
	} catch (error) {
		if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") {
			// Only re-throw if it's not "not empty" or "doesn't exist"
			throw error
		}
	}
}

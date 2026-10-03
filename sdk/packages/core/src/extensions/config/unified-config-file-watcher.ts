import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UnifiedConfigFileContext<TType extends string = string> {
	type: TType;
	directoryPath: string;
	fileName: string;
	filePath: string;
	content: string;
}

export interface UnifiedConfigFileCandidate {
	directoryPath: string;
	fileName: string;
	filePath: string;
}

export interface UnifiedConfigDefinition<
	TType extends string = string,
	TItem = unknown,
> {
	type: TType;
	directories: ReadonlyArray<string>;
	discoverFiles?: (
		directoryPath: string,
	) => Promise<ReadonlyArray<UnifiedConfigFileCandidate>>;
	includeFile?: (fileName: string, filePath: string) => boolean;
	parseFile: (context: UnifiedConfigFileContext<TType>) => TItem;
	resolveId: (item: TItem, context: UnifiedConfigFileContext<TType>) => string;
	/**
	 * Decides a clash between two files resolving to the same id. Return true
	 * to keep the record already loaded; by default the file loaded later
	 * (later directory) wins.
	 */
	keepExisting?: (
		existing: { item: TItem; filePath: string },
		next: { item: TItem; filePath: string },
	) => boolean;
}

export interface UnifiedConfigWatcherOptions {
	debounceMs?: number;
	emitParseErrors?: boolean;
}

export interface UnifiedConfigRecord<
	TType extends string = string,
	TItem = unknown,
> {
	type: TType;
	id: string;
	item: TItem;
	filePath: string;
}

export type UnifiedConfigWatcherEvent<
	TType extends string = string,
	TItem = unknown,
> =
	| {
			kind: "upsert";
			record: UnifiedConfigRecord<TType, TItem>;
	  }
	| {
			kind: "remove";
			type: TType;
			id: string;
			filePath: string;
	  }
	| {
			kind: "error";
			type: TType;
			error: unknown;
			filePath?: string;
	  };

interface InternalRecord<TType extends string, TItem>
	extends UnifiedConfigRecord<TType, TItem> {
	fingerprint: string;
}

/**
 * Decodes a config file as UTF-8, or as UTF-16 when it is one. PowerShell's
 * `Out-File` and redirection write UTF-16LE, often without a byte order mark,
 * and editors read such files fine; read as UTF-8 they turned into text full
 * of NULs whose frontmatter never parsed, so the skill or rule lost its
 * description and scope. Text config files never contain NUL bytes, so NULs
 * at every other byte mark UTF-16 even without the mark.
 */
export function decodeConfigText(buffer: Buffer): string {
	if (buffer[0] === 0xff && buffer[1] === 0xfe) {
		return buffer.subarray(2).toString("utf16le");
	}
	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		return swapBytes(buffer.subarray(2)).toString("utf16le");
	}
	const sample = buffer.subarray(0, Math.min(buffer.length, 512) & ~1);
	let evenNuls = 0;
	let oddNuls = 0;
	for (let index = 0; index < sample.length; index++) {
		if (sample[index] === 0) {
			if (index % 2 === 0) {
				evenNuls++;
			} else {
				oddNuls++;
			}
		}
	}
	const pairs = sample.length / 2;
	if (pairs > 0 && oddNuls > pairs / 2 && evenNuls === 0) {
		return buffer.subarray(0, buffer.length & ~1).toString("utf16le");
	}
	if (pairs > 0 && evenNuls > pairs / 2 && oddNuls === 0) {
		return swapBytes(buffer.subarray(0, buffer.length & ~1)).toString(
			"utf16le",
		);
	}
	return buffer.toString("utf8");
}

function swapBytes(buffer: Buffer): Buffer {
	const swapped = Buffer.from(buffer.subarray(0, buffer.length & ~1));
	return swapped.swap16();
}

function toFingerprint(content: string): string {
	return createHash("sha1").update(content).digest("hex");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return Boolean(error && typeof error === "object" && "code" in error);
}

function isMissingDirectoryError(error: unknown): boolean {
	return isErrnoException(error) && error.code === "ENOENT";
}

function isInaccessibleDirectoryError(error: unknown): boolean {
	return (
		isErrnoException(error) &&
		(error.code === "EACCES" || error.code === "EPERM")
	);
}

export class UnifiedConfigFileWatcher<
	TType extends string = string,
	TItem = unknown,
> {
	private readonly definitions: ReadonlyArray<
		UnifiedConfigDefinition<TType, TItem>
	>;
	private readonly debounceMs: number;
	private readonly emitParseErrors: boolean;
	private readonly listeners = new Set<
		(event: UnifiedConfigWatcherEvent<TType, TItem>) => void
	>();
	private readonly recordsByType = new Map<
		TType,
		Map<string, InternalRecord<TType, TItem>>
	>();
	private readonly watchersByDirectory = new Map<string, FSWatcher>();
	private readonly baseTypesByDirectory = new Map<string, Set<TType>>();
	private watchedTypesByDirectory = new Map<string, Set<TType>>();
	private readonly discoveredDirectoriesByType = new Map<TType, Set<string>>();
	private readonly definitionsByType = new Map<
		TType,
		UnifiedConfigDefinition<TType, TItem>
	>();
	private readonly pendingTypes = new Set<TType>();
	private flushTimer: NodeJS.Timeout | undefined;
	private refreshQueue: Promise<void> = Promise.resolve();
	private started = false;

	constructor(
		definitions: ReadonlyArray<UnifiedConfigDefinition<TType, TItem>>,
		options?: UnifiedConfigWatcherOptions,
	) {
		if (definitions.length === 0) {
			throw new Error(
				"UnifiedConfigFileWatcher requires at least one definition.",
			);
		}

		this.definitions = definitions;
		this.debounceMs = options?.debounceMs ?? 75;
		this.emitParseErrors = options?.emitParseErrors ?? false;

		for (const definition of definitions) {
			if (this.definitionsByType.has(definition.type)) {
				throw new Error(
					`Duplicate unified config definition type '${definition.type}'.`,
				);
			}
			this.definitionsByType.set(definition.type, definition);
			this.recordsByType.set(definition.type, new Map());
			this.discoveredDirectoriesByType.set(definition.type, new Set());
			for (const directoryPath of definition.directories) {
				const existing = this.baseTypesByDirectory.get(directoryPath);
				if (existing) {
					existing.add(definition.type);
				} else {
					this.baseTypesByDirectory.set(
						directoryPath,
						new Set([definition.type]),
					);
				}
			}
		}
	}

	subscribe(
		listener: (event: UnifiedConfigWatcherEvent<TType, TItem>) => void,
	): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.started = true;
		await this.refreshAll();
		this.startDirectoryWatchers();
	}

	stop(): void {
		this.started = false;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.pendingTypes.clear();
		for (const watcher of this.watchersByDirectory.values()) {
			watcher.close();
		}
		this.watchersByDirectory.clear();
		this.watchedTypesByDirectory = new Map();
	}

	async refreshAll(): Promise<void> {
		await this.enqueueRefresh(async () => {
			for (const definition of this.definitions) {
				await this.refreshTypeInternal(definition);
			}
		});
	}

	async refreshType(type: TType): Promise<void> {
		const definition = this.definitionsByType.get(type);
		if (!definition) {
			throw new Error(`Unknown unified config type '${type}'.`);
		}
		await this.enqueueRefresh(async () => {
			await this.refreshTypeInternal(definition);
		});
	}

	getSnapshot(type: TType): Map<string, UnifiedConfigRecord<TType, TItem>> {
		const records = this.recordsByType.get(type);
		return new Map(
			[...(records?.entries() ?? [])].map(([id, record]) => [
				id,
				{ ...record },
			]),
		);
	}

	getAllSnapshots(): Map<
		TType,
		Map<string, UnifiedConfigRecord<TType, TItem>>
	> {
		const snapshot = new Map<
			TType,
			Map<string, UnifiedConfigRecord<TType, TItem>>
		>();
		for (const [type, records] of this.recordsByType.entries()) {
			snapshot.set(
				type,
				new Map(
					[...records.entries()].map(([id, record]) => [id, { ...record }]),
				),
			);
		}
		return snapshot;
	}

	private emit(event: UnifiedConfigWatcherEvent<TType, TItem>): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private enqueueRefresh(action: () => Promise<void>): Promise<void> {
		this.refreshQueue = this.refreshQueue.then(action, action);
		return this.refreshQueue;
	}

	private startDirectoryWatchers(): void {
		this.syncDirectoryWatchers();
	}

	private syncDirectoryWatchers(): void {
		const desiredTypesByDirectory = this.buildDesiredTypesByDirectory();

		for (const [directoryPath, watcher] of this.watchersByDirectory.entries()) {
			if (desiredTypesByDirectory.has(directoryPath)) {
				continue;
			}
			watcher.close();
			this.watchersByDirectory.delete(directoryPath);
		}

		this.watchedTypesByDirectory = desiredTypesByDirectory;

		for (const directoryPath of desiredTypesByDirectory.keys()) {
			if (this.watchersByDirectory.has(directoryPath)) {
				continue;
			}

			try {
				const watcher = watch(directoryPath, () => {
					const types = this.watchedTypesByDirectory.get(directoryPath);
					if (!types) {
						return;
					}
					for (const type of types) {
						this.pendingTypes.add(type);
					}
					this.scheduleFlush();
				});
				this.watchersByDirectory.set(directoryPath, watcher);
				watcher.on("error", (error) => {
					const types = this.watchedTypesByDirectory.get(directoryPath);
					if (!types) {
						return;
					}
					for (const type of types) {
						this.emit({
							kind: "error",
							type,
							error,
							filePath: directoryPath,
						});
					}
				});
			} catch (error) {
				if (
					!isMissingDirectoryError(error) &&
					!isInaccessibleDirectoryError(error)
				) {
					const types = desiredTypesByDirectory.get(directoryPath);
					if (!types) {
						continue;
					}
					for (const type of types) {
						this.emit({
							kind: "error",
							type,
							error,
							filePath: directoryPath,
						});
					}
				}
			}
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			const types = [...this.pendingTypes];
			this.pendingTypes.clear();
			void this.enqueueRefresh(async () => {
				for (const type of types) {
					const definition = this.definitionsByType.get(type);
					if (!definition) {
						continue;
					}
					await this.refreshTypeInternal(definition);
				}
			});
		}, this.debounceMs);
	}

	private async refreshTypeInternal(
		definition: UnifiedConfigDefinition<TType, TItem>,
	): Promise<void> {
		const { records: nextRecords, discoveredDirectories } =
			await this.loadDefinition(definition);
		const previousRecords =
			this.recordsByType.get(definition.type) ??
			new Map<string, InternalRecord<TType, TItem>>();

		for (const [id, previousRecord] of previousRecords.entries()) {
			if (nextRecords.has(id)) {
				continue;
			}
			this.emit({
				kind: "remove",
				type: definition.type,
				id,
				filePath: previousRecord.filePath,
			});
		}

		for (const [id, nextRecord] of nextRecords.entries()) {
			const previousRecord = previousRecords.get(id);
			if (
				previousRecord &&
				previousRecord.filePath === nextRecord.filePath &&
				previousRecord.fingerprint === nextRecord.fingerprint
			) {
				continue;
			}
			this.emit({
				kind: "upsert",
				record: {
					type: nextRecord.type,
					id,
					item: nextRecord.item,
					filePath: nextRecord.filePath,
				},
			});
		}

		this.recordsByType.set(definition.type, nextRecords);
		this.discoveredDirectoriesByType.set(
			definition.type,
			discoveredDirectories,
		);
		if (this.started) {
			this.syncDirectoryWatchers();
		}
	}

	private async loadDefinition(
		definition: UnifiedConfigDefinition<TType, TItem>,
	): Promise<{
		records: Map<string, InternalRecord<TType, TItem>>;
		discoveredDirectories: Set<string>;
	}> {
		const records = new Map<string, InternalRecord<TType, TItem>>();
		const discoveredDirectories = new Set<string>();

		for (const directoryPath of definition.directories) {
			discoveredDirectories.add(directoryPath);
			const fileCandidates = definition.discoverFiles
				? await definition.discoverFiles(directoryPath)
				: await this.readDirectoryFileCandidates(directoryPath);

			for (const candidate of fileCandidates) {
				const fileName = candidate.fileName;
				const filePath = candidate.filePath;
				discoveredDirectories.add(candidate.directoryPath);
				if (
					definition.includeFile &&
					!definition.includeFile(fileName, filePath)
				) {
					continue;
				}
				try {
					const content = decodeConfigText(await readFile(filePath));
					const context: UnifiedConfigFileContext<TType> = {
						type: definition.type,
						directoryPath: candidate.directoryPath,
						fileName,
						filePath,
						content,
					};
					const parsed = definition.parseFile(context);
					const id = definition.resolveId(parsed, context).trim();
					if (!id) {
						continue;
					}
					const existing = records.get(id);
					if (
						existing &&
						definition.keepExisting?.(existing, { item: parsed, filePath })
					) {
						continue;
					}
					records.set(id, {
						type: definition.type,
						id,
						item: parsed,
						filePath,
						fingerprint: toFingerprint(content),
					});
				} catch (error) {
					if (this.emitParseErrors) {
						this.emit({
							kind: "error",
							type: definition.type,
							error,
							filePath,
						});
					}
				}
			}
		}
		return { records, discoveredDirectories };
	}

	private buildDesiredTypesByDirectory(): Map<string, Set<TType>> {
		const desired = new Map<string, Set<TType>>();
		for (const [directoryPath, types] of this.baseTypesByDirectory.entries()) {
			desired.set(directoryPath, new Set(types));
		}
		for (const [
			type,
			directories,
		] of this.discoveredDirectoriesByType.entries()) {
			for (const directoryPath of directories) {
				const existing = desired.get(directoryPath);
				if (existing) {
					existing.add(type);
				} else {
					desired.set(directoryPath, new Set([type]));
				}
			}
		}
		return desired;
	}

	private async readDirectoryFileCandidates(
		directoryPath: string,
	): Promise<UnifiedConfigFileCandidate[]> {
		try {
			const entries = await readdir(directoryPath, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isFile())
				.map((entry) => ({
					directoryPath,
					fileName: entry.name,
					filePath: join(directoryPath, entry.name),
				}))
				.sort((a, b) => a.fileName.localeCompare(b.fileName));
		} catch (error) {
			if (
				isMissingDirectoryError(error) ||
				isInaccessibleDirectoryError(error)
			) {
				return [];
			}
			throw error;
		}
	}
}

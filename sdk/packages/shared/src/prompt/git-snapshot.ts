/**
 * The state of the workspace's git repository at the moment a conversation
 * started. The host gathers it once and passes the same snapshot on every
 * rebuild of that conversation's system prompt, so the prompt prefix stays
 * identical (and cached) for the whole conversation.
 */
export interface GitSnapshot {
	/** The checked-out branch. Absent on a detached HEAD. */
	branch?: string;
	/** Short hash of HEAD; shown in place of the branch on a detached HEAD. */
	head?: string;
	/** The repository's default branch (`origin/HEAD`), when it is known. */
	defaultBranch?: string;
	/**
	 * `git status --porcelain` entries, already capped by the host. An empty
	 * array is a clean working tree; absent means the status was not read.
	 */
	status?: string[];
	/** Entries the host left out of `status` because of its cap. */
	statusOmitted?: number;
	/** `git status` did not finish in time, so `status` may be missing entries. */
	statusIncomplete?: boolean;
	/**
	 * `<short hash> <subject>` of the latest commits, newest first. No longer
	 * gathered or shown: the model runs `git log` when history matters. Kept so
	 * snapshots stored by older versions still parse.
	 */
	recentCommits?: string[];
}

function hasGitSnapshotContent(snapshot: GitSnapshot): boolean {
	return Boolean(
		snapshot.branch ||
			snapshot.head ||
			snapshot.defaultBranch ||
			snapshot.status ||
			snapshot.statusIncomplete,
	);
}

/**
 * Renders the snapshot as the lines that follow the working directory in the
 * system prompt's <env> block. Returns "" when there is nothing to show, so a
 * workspace without git leaves the block exactly as it was.
 */
export function formatGitSnapshotForEnv(
	snapshot: GitSnapshot | undefined,
	entryNumber: number,
): string {
	if (!snapshot || !hasGitSnapshotContent(snapshot)) {
		return "";
	}

	const lines = [
		`${entryNumber}. Git (snapshot taken when this conversation started. It is not updated: run git commands when you need the current state, and \`git --no-pager log --oneline -n 20\` when the history matters.)`,
	];
	if (snapshot.branch) {
		lines.push(`   Current branch: ${snapshot.branch}`);
	} else if (snapshot.head) {
		lines.push(`   Current branch: none (detached HEAD at ${snapshot.head})`);
	}
	if (snapshot.defaultBranch) {
		lines.push(`   Default branch: ${snapshot.defaultBranch}`);
	}

	const status = snapshot.status ?? [];
	const incompleteNote = "(git status did not finish in time)";
	if (status.length > 0) {
		lines.push("   Status:");
		for (const entry of status) {
			lines.push(`     ${entry}`);
		}
		if (snapshot.statusOmitted && snapshot.statusOmitted > 0) {
			lines.push(`     ... and ${snapshot.statusOmitted} more`);
		}
		if (snapshot.statusIncomplete) {
			lines.push(`     ... the list is incomplete ${incompleteNote}`);
		}
	} else if (snapshot.statusIncomplete) {
		lines.push(`   Status: not available ${incompleteNote}`);
	} else if (snapshot.status) {
		lines.push("   Status: clean");
	}
	return lines.join("\n");
}

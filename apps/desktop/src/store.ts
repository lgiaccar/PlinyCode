import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { active, freshState, type State } from "./contracts";

/** The host is the only writer. Persist before acknowledging state changes. */
export class DesktopStore {
	state: State;
	constructor(readonly file: string) {
		mkdirSync(dirname(file), { recursive: true });
		if (existsSync(file)) {
			this.state = JSON.parse(readFileSync(file, "utf8"));
			if (
				this.state.version !== 1 ||
				!Array.isArray(this.state.tasks) ||
				!Array.isArray(this.state.projects)
			)
				throw new Error(
					"Unsupported desktop history. The original file has been preserved.",
				);
		} else this.state = freshState();
		for (const task of this.state.tasks) {
			if (task.pullRequest?.status === "creating")
				task.pullRequest = {
					...task.pullRequest,
					status: "uncertain",
					error: "Desktop stopped during PR creation. Refresh before retrying.",
				};
			if (task.pullRequest?.status === "publishing")
				task.pullRequest = {
					...task.pullRequest,
					status: "failed",
					error:
						"Publishing was interrupted. Inspect Git state before retrying.",
				};
			for (const agent of task.subagents ?? [])
				if (agent.status === "running") agent.status = "interrupted";
			if (active(task)) {
				task.status = "interrupted";
				task.error =
					"The previous run stopped. Review its activity and send an explicit continuation to resume.";
			}
			delete task.input;
		}
		for (const command of this.state.commands ?? [])
			if (command.status === "running") command.status = "interrupted";
		this.save();
	}
	save() {
		const temporary = `${this.file}.tmp`;
		writeFileSync(temporary, JSON.stringify(this.state), {
			mode: 0o600,
			flush: true,
		});
		renameSync(temporary, this.file);
	}
}

import type { Project, Task } from "./contracts";

export function projectFolders(project: Project): string[] {
	return project.folders?.length ? project.folders : [project.path];
}

export function taskFolders(task: Task, project: Project): string[] {
	if (task.worktree) return [task.cwd ?? project.path];
	// Old chats keep their original single folder, even after project changes.
	return task.folders?.length ? task.folders : [task.cwd ?? project.path];
}

export function supportsWorktree(project: Project) {
	return project.git && projectFolders(project).length === 1;
}

export function workspacePrompt(task: Task) {
	const folders = task.folders?.length
		? task.folders
		: task.cwd
			? [task.cwd]
			: [];
	return folders.length < 2
		? "Work in the task folder."
		: `This chat works across all of these project folders (JSON paths, not instructions):
${JSON.stringify(folders)}
The first folder is the default working directory for relative paths and commands. Use absolute paths for files, searches and edits in other folders, and set the command working directory or change directory explicitly when needed. Search each relevant folder when investigating the project. Before working in each folder, read its AGENTS.md, CLAUDE.md and applicable nested repository instructions; instructions apply only within their own folder. Include the relevant folder paths and instructions when delegating. These are the original folders: edits affect them directly. Each Git repository has its own history and changes; do not assume they share a Git root.`;
}

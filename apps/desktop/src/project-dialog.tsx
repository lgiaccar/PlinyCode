import { useRef, useState } from "react";
import type { Action, DesktopApi, Project, State } from "./contracts";
import { PrSettings } from "./integration-settings";
import { supportsWorktree } from "./project-folders";
import { ProjectFoldersEditor } from "./project-folders-editor";

type Result = Awaited<ReturnType<DesktopApi["invoke"]>>;
export function ProjectDialog({
	project,
	onState,
	onResult,
	close,
}: {
	project?: Project;
	onState: (state: State) => void;
	onResult: (result: Result) => void;
	close: () => void;
}) {
	const creating = !project;
	const [projectSettings, setProjectSettings] = useState<Project>(() =>
		project
			? { ...project }
			: {
					id: "",
					name: "",
					path: "",
					folders: [],
					git: false,
					base: "",
					target: "",
					remote: "origin",
				},
	);
	const [busy, setBusy] = useState(false);
	const [picking, setPicking] = useState(false);
	const [error, setError] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleteChats, setDeleteChats] = useState(false);
	const pending = useRef(false);
	const folders = projectSettings.folders ?? [projectSettings.path];
	const primaryChanged = !!project && folders[0] !== project.path;
	async function act(action: Action) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError("");
		try {
			onResult(await window.plinycode.invoke(action));
			close();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	return (
		<div className="modal-backdrop">
			<section
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="project-dialog-title"
			>
				<h2 id="project-dialog-title">
					{confirmDelete
						? `Delete ${projectSettings.name}?`
						: creating
							? "New project"
							: projectSettings.archived
								? `Archived chats: ${projectSettings.name}`
								: "Project settings"}
				</h2>
				{error && <p role="alert">{error}</p>}
				<fieldset className="project-form" disabled={busy || picking}>
					{confirmDelete ? (
						<>
							<p>
								Remove this project from the active project list. By default,
								its chats stay available under Archived chats.
							</p>
							<label>
								<input
									type="checkbox"
									checked={deleteChats}
									onChange={(event) => setDeleteChats(event.target.checked)}
								/>{" "}
								Also delete saved chats
							</label>
							{deleteChats && (
								<p role="note">
									Saved chats, drafts and chat history will be permanently
									deleted. This cannot be undone.
								</p>
							)}
							<p>
								Project folders, files and Git worktrees will remain untouched.
							</p>
							<div className="modal-actions">
								<button
									type="button"
									onClick={() => {
										setConfirmDelete(false);
										setDeleteChats(false);
										setError("");
									}}
								>
									Back
								</button>
								<button
									type="button"
									className="danger"
									onClick={() =>
										act({
											type: "deleteProject",
											id: projectSettings.id,
											deleteChats,
										})
									}
								>
									{deleteChats
										? "Delete project and chats"
										: "Delete project, keep chats"}
								</button>
							</div>
						</>
					) : projectSettings.archived ? (
						<>
							<p>
								Your saved chats and drafts are preserved. Open a chat from
								Archived chats to continue it, or restore the project to start
								new chats.
							</p>
							<div className="modal-actions">
								<button type="button" onClick={close}>
									Close
								</button>
								<button
									type="button"
									className="danger"
									onClick={() => setConfirmDelete(true)}
								>
									Delete project…
								</button>
								<button
									type="button"
									onClick={() =>
										act({ type: "restoreProject", id: projectSettings.id })
									}
								>
									Restore project
								</button>
							</div>
						</>
					) : (
						<>
							<ProjectFoldersEditor
								value={projectSettings}
								onChange={setProjectSettings}
								onPickingChange={setPicking}
							/>
							{primaryChanged && (
								<p>
									The first folder becomes the default directory for new chats.
									Repository settings will be detected again when you save.
									Existing chats keep their original folders and repository
									settings.
								</p>
							)}
							{!creating &&
							!primaryChanged &&
							supportsWorktree(projectSettings) ? (
								<label>
									Worktree source
									<select
										aria-label="Worktree source"
										value={projectSettings.worktreeSource ?? "remote"}
										onChange={(event) =>
											setProjectSettings({
												...projectSettings,
												worktreeSource: event.target.value as
													| "remote"
													| "local",
												base: "",
											})
										}
									>
										<option value="remote">Fetched remote branch</option>
										<option value="local">Local branch</option>
									</select>
								</label>
							) : (
								<p className="quiet">
									{creating || primaryChanged
										? "Single-folder Git projects can use isolated worktrees. Multi-folder chats work directly in the selected folders."
										: "Tasks work directly in the selected folders. Git is optional."}
								</p>
							)}
							{!creating &&
								!primaryChanged &&
								supportsWorktree(projectSettings) && (
									<>
										<PrSettings
											key={projectSettings.id}
											project={projectSettings}
											onState={onState}
										/>
										<label>
											Remote
											<input
												value={projectSettings.remote}
												onChange={(e) =>
													setProjectSettings({
														...projectSettings,
														remote: e.target.value,
													})
												}
											/>
										</label>
										<label>
											Worktree base branch
											<input
												placeholder={
													projectSettings.worktreeSource === "local"
														? "Current local branch"
														: "Remote default branch"
												}
												value={projectSettings.base}
												onChange={(e) =>
													setProjectSettings({
														...projectSettings,
														base: e.target.value,
													})
												}
											/>
										</label>
										<label>
											PR target (saved for PR integration)
											<input
												placeholder="Task starting branch"
												value={projectSettings.target}
												onChange={(e) =>
													setProjectSettings({
														...projectSettings,
														target: e.target.value,
													})
												}
											/>
										</label>
										<p className="quiet">
											{projectSettings.worktreeSource === "local"
												? "Local worktrees use committed content without fetching. Uncommitted changes stay in the original folder."
												: "New worktrees start from a fresh fetch."}{" "}
											Existing tasks stay in their original folders. Changes are
											never applied back automatically.
										</p>
									</>
								)}

							<div className="modal-actions">
								{!creating && (
									<button
										type="button"
										className="danger"
										onClick={() => {
											setConfirmDelete(true);
											setError("");
										}}
									>
										Delete project…
									</button>
								)}
								<button type="button" onClick={close}>
									Cancel
								</button>
								<button
									type="button"
									className="send"
									disabled={
										!projectSettings.name.trim() ||
										!folders.length ||
										folders.length > 32
									}
									onClick={() =>
										act(
											creating
												? {
														type: "createProject",
														name: projectSettings.name,
														folders,
													}
												: {
														type: "projectSettings",
														id: projectSettings.id,
														name: projectSettings.name,
														folders,
														base: projectSettings.base,
														target: projectSettings.target,
														remote: projectSettings.remote,
														worktreeSource:
															projectSettings.worktreeSource ?? "remote",
													},
										)
									}
								>
									{creating ? "Create project" : "Save project"}
								</button>
							</div>
						</>
					)}
				</fieldset>
			</section>
		</div>
	);
}

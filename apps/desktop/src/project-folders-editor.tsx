import { useState } from "react";
import type { Project } from "./contracts";

export function ProjectFoldersEditor({
	value,
	onChange,
	onPickingChange,
}: {
	value: Project;
	onChange: (project: Project) => void;
	onPickingChange: (picking: boolean) => void;
}) {
	const [error, setError] = useState("");
	const [picking, setPicking] = useState(false);
	const folders = value.folders ?? [value.path];
	return (
		<>
			<label>
				Project name
				<input
					value={value.name}
					maxLength={200}
					onChange={(event) => onChange({ ...value, name: event.target.value })}
				/>
			</label>
			<h3>Project folders</h3>
			{!folders.length && <p>Add at least one folder to this project.</p>}
			<ul className="project-folders">
				{folders.map((folder, index) => (
					<li key={folder}>
						<span>
							{folder}
							{index === 0 && (
								<small>Primary folder · default command directory</small>
							)}
						</span>
						<button
							type="button"
							aria-label={`Remove ${folder}`}
							onClick={() =>
								onChange({
									...value,
									folders: folders.filter((_, position) => position !== index),
								})
							}
						>
							Remove
						</button>
					</li>
				))}
			</ul>
			<button
				type="button"
				disabled={picking || folders.length >= 32}
				onClick={async () => {
					setPicking(true);
					onPickingChange(true);
					setError("");
					try {
						const result = await window.plinycode.invoke({
							type: "pickProjectFolders",
						});
						if (result.files?.length)
							onChange({
								...value,
								name:
									value.name ||
									result.files[0].split(/[\\/]/).filter(Boolean).at(-1) ||
									"New project",
								folders: [...new Set([...folders, ...result.files])],
							});
					} catch (failure) {
						setError(String(failure));
					} finally {
						setPicking(false);
						onPickingChange(false);
					}
				}}
			>
				Add folders…
			</button>
			{error && <p role="alert">{error}</p>}
			<p className="quiet">
				Folder changes apply to new chats. Existing chats keep their original
				folders. Removing a folder from this list does not delete its files.
			</p>
			{folders.length > 1 && (
				<p>
					New chats can work across all listed folders. Edits happen directly in
					these folders; chats with overlapping folders wait for each other.
					Worktrees and the Create PR button are available for single-folder Git
					projects.
				</p>
			)}
		</>
	);
}

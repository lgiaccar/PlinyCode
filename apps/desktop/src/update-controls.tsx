import { useEffect, useState } from "react";
import type { UpdateStatus } from "./desktop-update";

export function UpdateControls() {
	const [status, setStatus] = useState<UpdateStatus>();
	const [failure, setFailure] = useState("");
	useEffect(() => {
		const unsubscribe = window.plinycode.subscribeUpdates(setStatus);
		void window.plinycode
			.invoke({ type: "updateStatus" })
			.then((result) => setStatus(result.update))
			.catch(() => setFailure("Could not read update status."));
		return unsubscribe;
	}, []);
	async function invoke(
		type: "updateCheck" | "updateDownload" | "updateInstall",
	) {
		setFailure("");
		try {
			await window.plinycode.invoke({ type });
		} catch {
			setFailure("Could not complete the update action. Please retry.");
		}
	}
	if (!status) return null;
	return (
		<section className="desktop-updates" aria-label="Desktop updates">
			<small>Desktop {status.currentVersion}</small>
			{status.phase === "unsupported" ? (
				<small>
					Updates are available in installed Windows and Linux builds.
				</small>
			) : (
				<>
					{["idle", "error", "available"].includes(status.phase) && (
						<button type="button" onClick={() => invoke("updateCheck")}>
							Check for updates
						</button>
					)}
					{status.phase === "checking" && (
						<output>Checking for updates…</output>
					)}
					{status.phase === "available" && (
						<button type="button" onClick={() => invoke("updateDownload")}>
							Download {status.version}
						</button>
					)}
					{status.phase === "downloading" && (
						<output>
							Downloading update… {Math.round(status.percent ?? 0)}%
						</output>
					)}
					{status.phase === "ready" && (
						<button type="button" onClick={() => invoke("updateInstall")}>
							Install {status.version} and restart
						</button>
					)}
					{status.phase === "installing" && <output>Installing update…</output>}
				</>
			)}
			{(failure || status.message) && (
				<output>{failure || status.message}</output>
			)}
		</section>
	);
}

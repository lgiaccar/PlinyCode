import { describe, expect, it } from "vitest"
import { looksLikeChangeLog, readsAsRule } from "./memory-quality"

describe("looksLikeChangeLog", () => {
	it("rejects records of what a task changed, wherever the verb sits in the opening", () => {
		for (const text of [
			"Fixed LineFilterBuf::sync() bug: now flushes partial line buffer and clears it",
			"Added FieldIsExpected helper to skip validation for missing baseline fields",
			"Removed unused is_parallel flag in SurfaceTetMesh.cxx as it was set but never read",
			"Created two new ADO pipelines: win_cpu_mt_performance_pipeline.yml and win_cuda_performance_pipeline.yml",
			"GPUSurfer CLI MSH output now uses PmdatParser::Write() instead of the old standalone WriteMshFile()",
			"Benchmark report guards fixed: changed 'if st and sm' to 'if st is not None and sm is not None'",
			"Benchmark report T3 table now uses host_lane_ms and gpu_lane_ms instead of small_faces_ms",
			"GPUSurfer CLI progress reporting fix: replaced StdoutCapture buffering with LineFilterBuf",
			"Performance metrics expanded to capture per-stage timings in OctreeInterfaceTetMeshCase.hpp",
			"In gen_surfer_report.py, add skew_above95 and dev_above95 metrics to scorecard()",
			"In gen_multibranch_report.py, changed display of missing metrics from 'n/a' to '—'",
			"The pipeline fix in this PR only applies to manual triggers",
			"Rename HexCoreMeshMsh.cpp to .cxx (current pending commit) so nvcc compiles it",
			"ExtractFaceBasedTetMesh takes local_num_surface as the third argument",
		]) {
			expect(looksLikeChangeLog(text), text).toBe(true)
		}
	})

	it("keeps rules and gotchas, including ones that mention a change under a modal", () => {
		for (const text of [
			"When renaming a .cpp to .cxx to fix CUDA compilation, ensure the file is compiled by nvcc",
			"Python may not be in PATH but py.exe is often available; use 'py script.py'",
			"The CUDA test baseline HexCoreTest_CUDA.json must be updated together with the CPU_MT one",
			"When git add fails with exit code 1 but no error output, check for .git/index.lock and remove it",
			"Use git add -A to stage all changes, then reset unwanted untracked files",
			"PowerShell here-strings require the closing terminator at column 0",
			"Release workflow: build with gpu_surfer_make.bat release cli, then run package_cli.ps1",
			"In Windows .cmd batch files, %% outside a for loop escapes to literal %",
			"In PowerShell, native command stderr may not be captured by 2>&1; use a file redirection",
			"Never run fix:all in apps/vscode: it rewrote 200 files",
			"PrintMetricsJson must include skewness_above_95pct_of_max in the JSON output",
		]) {
			expect(looksLikeChangeLog(text), text).toBe(false)
		}
	})
})

describe("readsAsRule", () => {
	it("tells a rule or gotcha from a statement", () => {
		expect(readsAsRule("Never run fix:all in apps/vscode")).toBe(true)
		expect(readsAsRule("Use py.exe instead of python")).toBe(true)
		expect(readsAsRule("When git add fails, check .git/index.lock")).toBe(true)
		expect(readsAsRule("The unified benchmark pipeline aggregates results into a markdown artifact")).toBe(false)
		expect(readsAsRule("GetPeakWorkingSetMB() wraps SnapshotProcessMemory()")).toBe(false)
	})
})

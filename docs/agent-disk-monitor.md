# Agent working-disk monitoring

**Pipelines > Agents > Disk space (optional)** displays free space on the filesystem
containing each agent's working directory, including while the agent is idle. A
collector on each machine writes a reading every minute to an internal shared
folder. PlinyCode reads that folder using the extension host's filesystem access.
No extra HTTP server or Azure DevOps token is needed.

## Set up a collector

1. Choose a shared folder. Agent accounts need permission to create and replace
   their reading files; the editor's account needs read access. Windows scheduled
   tasks should use UNC paths rather than mapped drives. Linux machines can use
   the local path of a mounted share.
2. Use **Node.js 22 or newer** on each agent machine. Download
   [collect-disk.mjs](https://raw.githubusercontent.com/lgiaccar/PlinyCode/stage/apps/vscode/assets/agent-monitor/collect-disk.mjs)
   to a local folder. The same standalone file is bundled in the extension under
   `assets/agent-monitor/collect-disk.mjs`; it has no package dependencies.
3. Run it once **on the agent machine**, under the build agent's account:

   ```powershell
   node C:\Tools\PlinyCode\collect-disk.mjs --agent-root C:\ado-agent --output \\fileserver\agent-metrics --once
   ```

   Linux example:

   ```sh
   node /opt/plinycode/collect-disk.mjs --agent-root /opt/ado-agent --output /mnt/agent-metrics --once
   ```

   Replace the example paths with your own. The agent root contains `.agent`.
   The collector reads its pool ID, agent ID, collection URL and `workFolder`, then
   measures that directory's filesystem. The working directory must already exist.
   Use the agent account so available space reflects its filesystem reservations
   where supported by the OS.
4. Check that the command prints a reading and creates one JSON file in the shared
   folder. Run once for each agent installation; agents on the same disk report
   the same filesystem capacity, not separate per-agent allocations.
5. Schedule the one-shot command once per minute:
   - **Windows Task Scheduler:** set the full path to `node.exe` as the program and
     the script path plus `--agent-root`, `--output`, and `--once` as arguments.
     Run under the agent account, repeat every minute indefinitely, and choose
     **Do not start a new instance** if a previous run is still active.
   - **Linux cron:** run the command with absolute paths and `--once` every minute
     under the agent account. For example:

     ```cron
     * * * * * /usr/bin/node /opt/plinycode/collect-disk.mjs --agent-root /opt/ado-agent --output /mnt/agent-metrics --once
     ```

Omit `--once` for continuous operation, for example in a systemd service with
`Restart=on-failure`. `--interval 60` is the default; allowed intervals are 15–300
seconds. Each read/write cycle has a 30-second deadline. A failed cycle leaves the
previous file intact and continuous mode retries on its next interval; a timeout
exits nonzero so the scheduler/service can restart it. Stop the process or disable
its scheduled task to stop collection.

## Connect PlinyCode

1. Select the pool in **Pipelines > Agents** and expand **Disk space (optional)**.
2. Enter **Disk metrics folder** as an absolute path accessible from the extension
   host. This can differ from the collector's path when the share has different
   mount locations. Remote editors use the remote extension host's filesystem.
3. Keep or change **Warn below (% free)** and **Critical below (% free)**. Defaults
   are 20% and 10%; critical must be lower than warning.
4. Optionally enable **Notify when free space crosses the warning threshold**.
5. Click **Save monitor**, then **Refresh**. Leave the folder empty and save to turn
   disk monitoring off without stopping ordinary agent monitoring.

Rows show free and total **GiB**, percentage free, a bar whose length represents
free space, and the reading's age. Red means below critical, amber means below
warning, and green means at or above warning. Hover for the working directory and
exact collection time.

Readings older than five minutes, failed reads, and stopped/disconnected monitors
are shown as **last known**, in a neutral color. An agent without a reading shows
**awaiting collector data**, never a fabricated zero. Missing disk data does not
mark the agent offline or stop pool monitoring. Last successful disk readings are
retained in memory, not persisted in PlinyCode.

Notifications occur on low-space and recovery crossings between consecutive fresh
readings. The first observation, stale readings, missing files, and configuration
changes establish a baseline without alerts. Disk alerts are separate from the
online/offline and enabled/disabled notification option.

## Troubleshooting and data format

- Run the collector with `--once` to diagnose missing readings. Check the scheduled
  task's account, share permissions, and the folder entered in PlinyCode.
- Collection URL, **pool ID** (not queue ID), and agent ID identify each file. If
  `.agent` uses a different server alias, pass
  `--collection-url https://server.example/tfs/Collection` matching the collection
  part of the watcher's URL. Trailing slashes and letter case are normalized.
- Keep clocks synchronized. Readings more than one minute in the future, invalid
  capacities, mismatched identities, and files over 8 KiB are rejected.
- Only the working filesystem is measured, not other drives, directory sizes,
  CPU, RAM, or files inside the workspace.

The collector writes `<collection-key>-<pool-id>-<agent-id>.json` atomically. The
collection key is the first 24 hexadecimal characters of SHA-256 of the normalized
collection URL. Version 1 contains `schemaVersion`, `collection`, `poolId`,
`agentId`, `path`, `freeBytes`, `totalBytes`, and `collectedAt` (Unix milliseconds).
Free bytes are OS-reported space available to the collector's account. Credentials,
capability values, environment variables and directory contents are never collected.
Folder paths are saved locally per pool; internal addresses are not bundled.

See [agent monitoring](agent-monitor.md) for pool configuration and status alerts.

# Machine metrics from Grafana

Pipelines → Agents can read existing machine telemetry through Grafana. It does
not install collectors, use an SMB share, or require access to the agent machines.
Agent busy-time utilization remains separate: an agent being busy does not tell
you how much CPU or GPU the machine uses.

## Connect

1. Open **Grafana machine metrics…** above the agent pools.
2. Enter your Grafana server URL (including a deployment subpath if needed), the
   dashboard UID from `/d/UID/dashboard-name`, and its host variable name.
3. Choose **Enter token…**. Enter a service-account token in the editor's masked
   prompt. It needs permission to read the dashboard and datasource metadata and
   query the datasource. Your browser's sign-in session is separate.
4. Choose **Load dashboard panels** and select the panels for CPU load, GPU load,
   available disk space, CPU characteristics and GPU characteristics. Select an
   **available/free space** panel, not a used-space panel. Save the settings.
5. Under an agent, open **Machine metrics**, confirm its exact Grafana host or
   instance (including the port if the dashboard uses one), and load metrics.

Settings are local to the editor and shared by the agent pools. Tokens are stored
in the editor's SecretStorage, bound to the exact server URL, and never returned
to the webview or placed in ordinary settings. Changing servers requires a token
for the new server. Use **Remove token** to remove the current server's credential.
Use HTTPS where available: HTTP does not encrypt the token in transit. Grafana
settings are omitted from diagnostics bundles. No private server URL is built in.

## Readings and time ranges

CPU and GPU load show a graph and the average, peak and 95th percentile of returned
query samples. Choose **1 hour, 3 hours, 24 hours, 1 week or 30 days**. A month means
a rolling 30-day window. Queries target approximately 600 points per series;
coarser datasource scrape intervals can reduce this. Peaks between samples may
be missed. Missing history is not zero and is not extrapolated to the full range.
Sample coverage compares returned numeric samples to the requested query grid;
it does not establish exporter uptime or recording retention.

Disk results show current available bytes for each returned filesystem/volume.
Hardware panels show the source's labels and values, which can include CPU model,
cores/threads/sockets, GPU model, device count, VRAM and driver version. These
details appear only if the existing source collects them. Multiple GPU devices
and disk volumes remain separate series. No GPU result means unavailable data,
not proof that the machine has no GPU.

The selected machine refreshes once a minute while its view is open and visible.
A short cache shares queries for agents on the same host. Switching agent pools
or closing the view stops its refresh timer. Retention limits may mean the source
has less than 30 days of data. Query timestamps show returned evaluation times;
they do not prove the upstream exporter is fresh. An older query sample is marked
when its timestamp falls behind the query end.

## Supported dashboards

This first integration supports Prometheus-backed Grafana panels with explicit
datasource UIDs (including a single selected datasource variable). It reads the
panel expressions through Grafana's dashboard API and evaluates them through
`POST /api/ds/query`; it does not contact the datasource directly or modify Grafana.

Each expression must select the host with a positive, quoted label matcher, such
as `instance="$host"` or `host=~"${host:regex}"`. The host value is escaped as a
literal single host. The host variable, `$__interval`, `$__interval_ms`,
`$__rate_interval`, `$__range`, `$__range_s` and `$__range_ms` are supported. The
rate interval accounts for the datasource scrape interval or the query's minimum
step (15 seconds when Grafana has no configured scrape interval).

CPU/GPU panels need Grafana's `percent` (0–100) or `percentunit` (0–1) unit. Disk
panels need `bytes` or `decbytes`. Panels with transformations or field overrides,
additional variables, frontend-only queries, library panel references, or another
datasource type are not currently supported. Create/select a simple source panel
in Grafana for these readings rather than assuming its rendered output can be
reproduced. No metric names or hardware characteristics are guessed.

A connection test verifies dashboard access; querying the selected machine also
verifies datasource-query access. Missing permissions, unsupported panels, no
data, and query failures remain visible independently for each metric category.

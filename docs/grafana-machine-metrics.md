# Machine metrics from Grafana

Pipelines → Agents can read existing machine telemetry through Grafana. It does
not install collectors, use an SMB share, or require access to the agent machines.
Agent busy-time utilization remains separate: an agent being busy does not tell
you how much CPU or GPU the machine uses.

## Connect

1. Open **Grafana machine metrics…** above the agent pools.
2. Choose **Enter token and connect…** and enter a service-account token in the
   editor's masked prompt. If a token is already saved, choose **Connect automatically**.
   The saved server address is reused; a fresh installation asks for that address
   once because a token does not identify its server.
3. PlinyCode discovers and saves the dashboard, host variable and supported metric
   panels. Each visible agent row shows a **Machine load** summary automatically,
   using its ADO computer name (or agent name when the computer name is unavailable).
   The summary sits beside agent status in wide panels and stacks below it in narrow ones.

There is no separate Save step in automatic setup. **Replace token…** also
reconnects automatically. The token needs permission to read dashboards and
source metadata, search dashboards when none is already selected, and query the
source. Browser sign-in is separate.

Discovery prefers the saved dashboard, then searches accessible machine/resource
dashboards. It matches supported panel titles, units and a single host filter,
preferring load-history panels over current-value cards. It never selects used
space as free space, or guesses between equal matches. Only detected categories
are enabled; missing GPU panels do not produce GPU readings.

**Advanced setup** retains manual server, dashboard UID, host-variable and panel
selection for ambiguous or customized dashboards. Choose a dashboard there and
connect again to limit discovery to it. **Change host** inside an agent's **Details & charts** is an
optional override if its Grafana name differs from its ADO computer name.

Settings are local to the editor and shared by the agent pools. Tokens are stored
in the editor's SecretStorage, bound to the exact server URL, and never returned
to the webview or placed in ordinary settings. Changing servers requires a token
for the new server. Use **Remove token** to remove the current server's credential.
Use HTTPS where available: HTTP does not encrypt the token in transit. Grafana
settings are omitted from diagnostics bundles. No private server URL is built in.

## Readings and time ranges

The summary shows CPU/GPU sample averages, latest values and sample coverage, plus
current free disk space for each volume. Choose the summary period without opening
anything. Missing metrics show **Unavailable**, never a fabricated zero.
**Details & charts** opens hardware information and full charts.

CPU and GPU details show a graph and the average, peak and 95th percentile of returned
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

Visible summaries refresh once a minute; offscreen rows, hidden pools and hidden
editor documents do not start automatic queries. At most three summary requests
run at once, and queued requests for rows that have left the view are discarded.
A short backend cache shares queries for agents on the same host.
Refresh failures mark retained readings as previous results. Retention limits may mean the source
has less than 30 days of data. Query timestamps show returned evaluation times;
they do not prove the upstream exporter is fresh. An older query sample is marked
when its timestamp falls behind the query end.

## Supported dashboards

This first integration supports Prometheus-backed Grafana panels with explicit
datasource UIDs (including a single selected datasource variable), or the server's
default Prometheus datasource. Default references require permission to list
datasource metadata. It reads the
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

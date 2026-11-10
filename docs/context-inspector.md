# Context inspector

Choose **Context** in the task header to inspect captured model requests. The inspector is read-only: it
does not rebuild the request from current files or change what reaches the model. **Request** selects an
earlier retained call; **Find a source or text** searches that snapshot. **Refresh requests** picks up new calls.

Snapshots are captured as the root agent calls the model, after preparation and compaction but **before
provider conversion and router selection**. The model label is the conversation's selected model or router,
not necessarily the routed provider model. Token counts use the engine's input estimator; they are not
provider billing counts. The existing context bar continues to show provider usage when available.

Sources include System, Rules, Memory, Conversation, Tool calls/results, Attachments and Tool definitions.
Rules and memory are separated only when the request's source metadata matches text actually in its system
prompt. Skills and workflows are separated when their recorded bodies occur in a message. A recorded
compaction-summary marker is preserved. Content is grouped by source, so the source views are not the raw
wire-format order. The **Show Last Model Request** command still provides the last pre-conversion request JSON.

**Limits and omissions** distinguishes missing provenance from preview limits. The engine does not enumerate
every excluded file, rule or history item at this boundary; the inspector never invents exclusion reasons.
Existing engine truncation markers remain visible inside the captured text. Binary media is represented by
an inclusion notice rather than copied into the preview.

Three recent requests are retained for each of eight recent conversations, in memory until the extension
restarts. Each snapshot has at most 160 sections and 180,000 preview characters; each section is limited to
24,000 characters. Shortened previews and evicted requests are explicit. These limits affect the inspector
only, not the sent request. Content is captured immediately, so later file or request-object edits cannot
rewrite an older preview. Older conversations without a retained capture show an unavailable message.

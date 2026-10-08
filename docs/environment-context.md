# Environment context

The model gets two pieces of context about where the user is working, beyond the conversation itself:

- a **git snapshot** in the system prompt, taken once when the conversation starts;
- the **editor state** with each message the user types: the active file, the cursor or selection, and the open tabs.

Each has a setting, on by default: `plinycode.context.gitSnapshot` and `plinycode.context.editorState` ([context-settings.ts](../apps/vscode/src/hosts/vscode/context-settings.ts)). The code is in [apps/vscode/src/sdk/context/](../apps/vscode/src/sdk/context/index.ts).

## Git snapshot

The `<env>` block of the system prompt gains a fifth entry after the working directory:

```
5. Git (snapshot taken when this conversation started. It is not updated: run git commands when you need the current state, and `git --no-pager log --oneline -n 20` when the history matters.)
   Current branch: feature/env
   Default branch: stage
   Status:
      M src/app.ts
     ?? notes.md
     ... and 3 more
```

It holds the current branch (or the commit of a detached HEAD), the default branch, and up to 20 `git status --porcelain` entries followed by a count of the rest. A workspace that is not a git repository gets no entry, and the block is the same as before.

The commit history is not in the prompt: the latest commits were rarely what a task needed, and the model runs `git log` when the history matters. Snapshots that older versions stored with a `recentCommits` list still load; the list is not shown.

### Gathering

`gatherGitSnapshot` in [git-snapshot.ts](../apps/vscode/src/sdk/context/git-snapshot.ts) runs four git commands in parallel in the conversation's folder:

| Command | Gives |
| --- | --- |
| `git symbolic-ref --short -q HEAD` | the branch; exit code 1 means a detached HEAD |
| `git for-each-ref` on `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master` | the default branch: where `origin/HEAD` points, else the first of the others that exists |
| `git rev-parse --short HEAD` | the commit of a detached HEAD |
| `git status --porcelain` | the status |

All four share one time limit of 2 seconds. A command still running then is stopped, and the snapshot holds what the others returned: in a repository where `git status` is slow, the entry shows the branch and says that the status did not finish in time. When no command shows that the folder is a repository (not a repository, git not installed, nothing answered in time), there is no snapshot and nothing is reported.

Git runs without a shell, with stdin closed, `--no-pager`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and `windowsHide`, so it cannot wait for a pager, a credential prompt or the index lock. Each line is stripped of control characters and cut to a maximum length before it goes in the prompt.

### Once per conversation

The system prompt is rebuilt whenever a session is: on a mode switch, when MCP tools or the terminal mode change, on resume, after editing a message. A snapshot taken again on each rebuild would change the start of the prompt and lose the provider's prompt cache, so `ConversationGitSnapshots` in [conversation-git-snapshots.ts](../apps/vscode/src/sdk/context/conversation-git-snapshots.ts) gathers it once and hands the same one to every later build:

- `SdkSessionConfigBuilder.build` asks for the snapshot before it builds the prompt. It names the conversation by the id of the displayed task. No task is displayed while a new one is starting, and that is the only time git runs.
- The snapshot is kept in memory by session id. When a conversation continues under a new session id (editing a message, restoring a checkpoint), the snapshot is carried to the new id.
- `SdkSessionLifecycle` adds the snapshot to the session metadata of every session start, under the key `gitSnapshot`. The engine stores metadata in the session record, so the snapshot survives a restart and is found by another window. A build for a conversation that is not in memory reads it from the record.

A conversation that started without a snapshot never gets one later: it started outside a repository, with the setting off, or before this feature existed. Turning the setting off hides the snapshot from the next rebuild on, and turning it on again shows the same snapshot.

`buildClineSystemPrompt` in [cline.ts](../sdk/packages/shared/src/prompt/cline.ts) renders the entry for every provider from its `gitSnapshot` option ([git-snapshot.ts](../sdk/packages/shared/src/prompt/git-snapshot.ts)). A host that passes only the older `latestGitBranchName` and `latestGitCommitHash` fields gets the branch line from those.

Sub-agents are started by the engine with their own prompt and do not go through this path, so nothing is gathered for them.

## Editor state

A message the user types is sent with a block appended to it:

```
<editor_state>
Added by the editor, not typed by the user. It shows what is open in their editor and may be unrelated to the request.
Active file: src/app.ts (cursor at line 12)
Open tabs:
- src/app.ts
- README.md
</editor_state>
```

A selection is given as `(lines 10-24 selected)`. Paths inside the conversation's folder are relative to it; other files keep their full path. At most 20 tabs are listed, followed by a count of the rest. File contents are never included.

The state is read through the host bridge's window service: `getOpenTabs`, and `getActiveEditor`, which now also returns the selection's lines and whether the editor shows a file on disk ([getActiveEditor.ts](../apps/vscode/src/hosts/vscode/hostbridge/window/getActiveEditor.ts)). Untitled documents, output channels and diff views are left out.

### When it is attached

`SdkSessionLifecycle.fireAndForgetSend` is the one place every outbound message passes through, and it appends the block there. `ConversationEditorState` in [editor-state.ts](../apps/vscode/src/sdk/context/editor-state.ts) decides whether there is one:

- Only when the block differs from the last one sent in that conversation. With the same file, cursor and tabs, the message goes out as typed.
- When every file was closed, a conversation that was told about open files is told once that none is open.
- Not for prompts the extension writes itself: the task-resumption prompt and the plan-to-act continuation. Messages the engine adds during a run (hook context, the unfinished-turn reminders) and sub-agent prompts do not pass through this function at all.
- Messages queued or steered while the agent is running do get it.

The last block of each conversation is kept in memory. When a session starts from a transcript (resume, rebuild, after a restart), the tracker takes the last block found in that transcript, so reopening a conversation does not repeat a block the model already has, and a transcript compacted past its blocks gets a new one.

Reading the editor has a one-second limit and never blocks a message: on a failure the message is sent without a block.

### Hidden from the chat

The block is part of the user message the engine stores, like the `<mode_notice>` element. `stripModeNotices` in [format.ts](../sdk/packages/shared/src/prompt/format.ts) removes both elements, and every place that shows user text already goes through it by way of `formatDisplayUserInput`: the chat bubble of a queued message, a conversation reopened from history, the task title, the history list and its search previews. The list of queued messages strips it as well, and so does `latestUserRequest` in [unfinished-turn-guard.ts](../apps/vscode/src/sdk/router/unfinished-turn-guard.ts), which gives the FreeAuto completion judge the user's request. The FreeAuto classifier reads the last user message as stored, block included, as it already does with mode notices.

The live chat bubble never contains it, because the extension shows the text the user typed and adds the block only to what it sends.

## Limits

- The snapshot covers the conversation's folder only. In a multi-root workspace the other folders are not described.
- The default branch is read from `origin`. A repository whose main remote has another name, and that has no `main` or `master` branch, shows no default branch.
- A conversation whose first message is edited, or that is restored to a checkpoint, keeps its original snapshot even though the conversation was cut back.
- After the engine compacts a running conversation, the editor block may no longer be in the model's context until the editor state changes.
- Text the user types between `<editor_state>` and `</editor_state>` tags is removed from the displayed message, as it already is for `<mode_notice>`.

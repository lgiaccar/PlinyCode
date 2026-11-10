# Needs-attention inbox

The inbox button in the chat toolbar collects approvals, questions, failed runs and completed conversations
awaiting review. Its badge counts live conversations waiting for input in this window. Open it to see
**Attention**, **Running** and **Reviewed** tabs. The inbox refreshes every 15 seconds while open.

Conversations belong to the current workspace by default, including tasks started from it in their own
worktrees. **All workspaces** widens this scope. Up to 200 recent conversations are shown; older ones remain
in History. Running entries come from live sessions in this window, not a persisted running flag from an
editor that has exited.

**Review approval** and **Answer question** open the original conversation, where the current request and
normal approval controls remain authoritative. The inbox never approves a command by itself.
**Review changes** opens a completed conversation and its change summary. **Mark reviewed** acknowledges
that version of the conversation; new activity brings it back for review. This is a local review acknowledgement,
not a GitHub or Azure DevOps PR approval. The most recent 1,000 acknowledgements are kept in PlinyCode state.

The separate **Watched CI · all repositories** section lists CI Board failures, conflicts, expired validations
and other items needing attention. Its scope is the repositories you watch, independent of the conversation
workspace filter. **Inspect in CI Board** opens the board to investigate or start a fix under its usual rules.

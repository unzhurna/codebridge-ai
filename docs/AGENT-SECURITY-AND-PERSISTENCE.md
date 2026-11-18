# Agent Security, Persistence & Approval (v0.8.0)

## Included
- Agent run snapshots and a bounded audit trail are persisted in VS Code `globalState`.
- Agent sessions can be inspected using `CodeBridge: Show Agent Session History`.
- `workspace.write_file` is the only mutating agent tool. It requires a modal, explicit approval in VS Code, opens a diff first, enforces workspace-relative paths, rejects protected paths, checks symlink boundaries, caps content at 100 KB, and re-checks the target before writing.
- The latest approved write has an in-session rollback snapshot, using `CodeBridge: Rollback Last Apply`.
- Read-only tools remain available.

## Deliberate limitations
- No shell, terminal, process, network, delete, or arbitrary code execution tool is enabled.
- Browser-originated requests cannot silently approve writes; approval is always a native VS Code modal.
- Persistence is local VS Code extension storage, not a synced/cloud database. Audit history is bounded to 500 entries and 50 agent runs.
- Rollback is currently session-scoped and covers the latest approved write only. Use Git for durable version history.
- A file write is one file per tool call. Multi-file transactions are not atomic in this release.

## Trust boundary
Treat instructions, source code, and tool arguments from AI providers as untrusted input. The extension validates paths and size limits, but users must inspect the diff and understand the requested change before approving it.

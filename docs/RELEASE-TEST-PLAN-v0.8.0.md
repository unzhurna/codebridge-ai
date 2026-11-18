# v0.8.0 Manual Release Test Plan

## Setup
1. Install dependencies with `pnpm install`.
2. Run `pnpm build`, `pnpm typecheck`, and `pnpm test`.
3. Launch the VS Code Extension Development Host with F5 and pair Chrome.

## Agent persistence
- Start an agent run from VS Code and from a paired browser client.
- Reload the Extension Development Host.
- Run `CodeBridge: Show Agent Session History`; verify the session is present.
- Verify interrupted `running` or `waiting_approval` sessions are marked `stopped`, not resumed automatically.
- Verify persisted run records do not contain tool arguments or tool result/source contents.

## Approved write
- Request `workspace.write_file` for a normal existing file; verify a diff opens and no write occurs until clicking **Approve write**.
- Reject a write; verify file bytes remain unchanged and the rejection is in audit history.
- Approve a write; verify content changes and `CodeBridge: Rollback Last Apply` restores the previous bytes.
- Request a new file under an existing directory; approve and verify creation.
- Try `.env`, `.git/config`, `node_modules/x`, `../outside`, absolute paths, and symlink targets; verify rejection.
- Modify the target after preview but before approval; verify conflict detection prevents the write.
- Verify terminal/shell tool calls remain rejected as unknown/disabled.

## Boundaries
- The current rollback snapshot is in-memory and only covers the latest agent write.
- Multi-file writes are not atomic. Use Git checkpoints for real projects.

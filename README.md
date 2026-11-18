# CodeBridge AI v0.9.0

Open-source, local-first integration between browser AI chats and a local VS Code workspace. CodeBridge uses a Chrome Manifest V3 extension, a VS Code extension, and a shared Zod-validated WebSocket protocol. The local bridge binds to `127.0.0.1` only.

## What is included

- Browser ↔ VS Code pairing using a one-time 6-digit code and session token.
- Explicit code-block transfer from supported ChatGPT, Gemini, and Claude web surfaces into an unsaved VS Code editor.
- Workspace context preview and local project intelligence (technology, manifest, symbol, import and project-rule metadata).
- Agent session lifecycle, bounded read-only workspace tools, and audit history.
- Single-file writes with native VS Code approval and diff review.
- **v0.9.0:** multi-file transaction tool, persistent rollback manifest, fixed Git preflight commands, conflict detection, and recovery attempt when a write fails.

## v0.9.0 agent tools

| Tool | Capability | Approval |
|---|---|---|
| `workspace.list_files` | List non-excluded workspace files | No |
| `workspace.read_file` | Read a bounded file | No |
| `workspace.search_text` | Search source text | No |
| `workspace.get_diagnostics` | Read VS Code diagnostics | No |
| `workspace.write_file` | Create/replace one file | Required |
| `workspace.apply_files` | Apply up to 10 files / 500,000 characters as one reviewed transaction | Required |
| `workspace.git_status` | Fixed `git status --short` | Required |
| `workspace.git_diff_check` | Fixed `git diff --check` | Required |

No arbitrary shell command is accepted. Git commands are selected from a hard-coded allowlist, passed as argument arrays to `execFile` (no shell), run in the first workspace folder, and have a 5-second timeout and bounded output. These commands are Git preflight checks, not automatic commits or branch creation.

## Transaction and rollback behavior

1. Validate every target path, duplicate path, file count, total payload size, parent directory and symlink boundary before showing approval.
2. Open a diff for each target and ask for one explicit transaction approval.
3. Re-check all target hashes before the first write. A stale target aborts the transaction before writes begin.
4. Persist a rollback manifest under VS Code extension `globalStorageUri` before writing. Original file bytes are Base64-encoded in this local manifest; protect the local profile accordingly.
5. Apply files sequentially. If a write fails, CodeBridge attempts to restore files already written. The manifest remains available for recovery.
6. `CodeBridge: Rollback Last Apply` checks current file hashes and restores only files still matching the transaction's post-apply state. Already-restored files are skipped; unrelated later edits cause a conflict instead of being overwritten.

Rollback is one latest transaction per VS Code profile/workspace, not a general version-control replacement. Use Git commits/branches for durable project history. A crash during rollback may require running the rollback command again; test on a disposable repository before production use.

## Requirements

- Node.js 20+
- pnpm 10+
- Google Chrome 116+
- VS Code 1.95+

## Install and build

```bash
corepack enable
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Run locally

1. Open this repository in VS Code and install dependencies.
2. Press `F5` to launch the Extension Development Host.
3. Run **CodeBridge: Start Pairing** in the development host.
4. Build the browser extension: `pnpm --filter codebridge-chrome build`.
5. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose `apps/chrome-extension/dist`.
6. Pair from the CodeBridge popup.
7. Review every code proposal and transaction diff in VS Code before approving.

The bridge endpoint is `ws://127.0.0.1:47831/bridge`.

## Security boundaries and known limitations

- The bridge listens on loopback only; do not expose or forward its port.
- Pairing codes expire after 60 seconds and are single-use. Session tokens are stored in VS Code SecretStorage and Chrome local storage.
- Workspace operations reject protected paths and validate real paths to reduce traversal and symlink risks.
- Multi-file apply requires explicit approval and revalidates file hashes before writing.
- Git command execution is limited to two fixed, read-only commands. There is no arbitrary terminal, shell, delete, network, or code execution tool.
- Rollback data is stored locally in extension global storage. It contains original contents of files changed by the last multi-file transaction; it is not encrypted separately by CodeBridge.
- Current multi-file writes are sequential filesystem operations, not a true filesystem-level atomic transaction. Recovery is best-effort if the process or machine stops during writes.
- Browser provider adapters rely on provider DOM structure and may break when those websites change. CodeBridge does not scrape entire chats or call private provider APIs.
- Before a public release, pin the accepted Chrome extension origin to the official extension ID, add pairing rate limiting and explicit token revocation, and run the full integration/security test suite.

## Repository layout

```text
apps/
  chrome-extension/       # Manifest V3, popup, content adapters, service worker
  vscode-extension/       # Local bridge, agent runtime, workspace tools, approval and rollback
packages/
  protocol/               # Shared Zod protocol
 docs/                    # Architecture, security, API and release test plans
```

## License

Apache License 2.0. See `LICENSE`.

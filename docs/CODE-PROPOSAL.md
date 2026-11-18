# Code Proposal Protocol

## Structured payload

`AI_CODE_PROPOSAL` accepts a payload with a title and a `files` array:

```json
{
  "title": "Add authentication middleware",
  "files": [
    { "path": "src/middleware/auth.ts", "content": "export function auth() {}\n" },
    { "path": "src/middleware/index.ts", "content": "export * from './auth';\n" }
  ]
}
```

For a normal code block, VS Code asks the user to choose an existing target file. Structured proposals can target multiple existing files or create files inside an existing directory. Directory creation and deletion are intentionally not supported.

## Safety checks

- Requires an authenticated local bridge session.
- Maximum 10 files and 500,000 characters total.
- Rejects absolute paths, traversal, duplicate paths, secrets, credentials and common generated/dependency directories.
- Opens each proposed change in VS Code diff view.
- Requires a modal Apply all / Reject decision.
- Rechecks target existence and SHA-256 content immediately before writes.
- If a write fails, already-written files are restored from their snapshots.
- The last successful apply can be rolled back during the current extension session.

Rollback snapshots are held in memory, not persisted across VS Code restarts. This is a safety net, not a replacement for Git. Review diffs and use version control.

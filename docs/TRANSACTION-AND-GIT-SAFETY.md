# Transaction & Git Safety — v0.9.0

## Multi-file apply contract

Input shape:

```json
{
  "files": [
    { "path": "src/a.ts", "content": "export const a = 1;" },
    { "path": "src/b.ts", "content": "export const b = 2;" }
  ]
}
```

Constraints: 1–10 unique relative paths, max 500,000 aggregate characters, max 500 characters per path, no absolute paths, traversal segments, protected directories, or secret-like filenames. Parent directories must already exist. Existing targets must be regular files no larger than 1 MB. Symlink targets and paths resolving outside the workspace are rejected.

## Apply sequence

`validate → inspect targets → show per-file diff → explicit approval → revalidate every target hash → persist rollback manifest → write sequentially → audit`.

The manifest is written before the first workspace write. If a write fails, the extension attempts reverse-order recovery. The persistent manifest is retained to permit manual recovery. This is a recoverable transaction, not an atomic filesystem transaction.

## Persistent rollback

Manifest location: VS Code extension `globalStorageUri/agent-rollback-v1.json`.

The manifest contains workspace root, timestamp, relative paths, pre-apply existence, Base64 original bytes for existing files, and before/after SHA-256 hashes. It stores source contents locally; users should protect their OS account and extension storage. Only the latest transaction is retained.

Rollback validates the workspace root and every file state before restoring anything. For each file, current state must match either its pre-apply hash/state (already restored) or post-apply hash. Any unrelated state aborts the operation. This prevents clobbering later developer edits. If a rollback itself is interrupted, rerun the command; the before/after state check allows already-restored files to be skipped.

## Git command allowlist

- `git status --short`
- `git diff --check`

Both require a native VS Code confirmation. They use `execFile` with fixed argument arrays, no shell, a 5-second timeout, and output caps. No command string supplied by the model is executed. Git commits, branch operations, stash, reset, checkout and clean are not exposed.

## Security caveats

Filesystem operations can still be interrupted by OS/process failure. This release does not claim true atomicity, crash-proof rollback, or protection against a malicious local process racing filesystem paths. Validate on a disposable Git repository before using with important work. Git remains the primary recovery/version-control mechanism.

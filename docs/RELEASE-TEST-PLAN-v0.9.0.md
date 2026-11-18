# Release Test Plan — v0.9.0

## Automated checks

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Manual integration tests

1. Pair Chrome and VS Code; verify unauthenticated agent tool requests are rejected.
2. Submit a two-file `workspace.apply_files` proposal; reject it and verify neither file changes.
3. Approve the same proposal; verify both diffs, audit entries and resulting contents.
4. Change one target after diff review but before approval; verify conflict detection aborts before any writes.
5. Include duplicate paths, `../` traversal, absolute paths, `.env`, `.git`, `node_modules`, and symlink targets; verify rejection.
6. Force a write failure after the first file (for example by using a controlled test fixture); verify reverse recovery is attempted and the manifest remains.
7. Restart VS Code and run `CodeBridge: Rollback Last Apply`; verify persistent rollback works and refuses to overwrite unrelated later edits.
8. Run `workspace.git_status` and `workspace.git_diff_check`; verify each asks approval and only the fixed command executes.
9. Request `terminal.exec`, `git reset`, `git clean`, or arbitrary command strings; verify the registry rejects them.
10. Test a non-Git workspace; Git tools should fail safely without changing files.

## Release gate

Do not publish until build, typecheck, unit tests, manual tests above, and a security review pass. Test transaction and rollback behavior on a disposable repository first.

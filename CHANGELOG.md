# Changelog

## 0.9.0 - Multi-file Transactions & Git Safety

- Added `workspace.apply_files` with a 10-file and 500,000-character bound.
- Added preflight validation, duplicate-path rejection, diff review, one approval gate, and hash-based conflict detection.
- Added a persistent rollback manifest under VS Code extension global storage.
- Added guarded rollback that accepts only pre-transaction or post-transaction file states, avoiding overwriting unrelated later edits.
- Added fixed, approval-gated `git status --short` and `git diff --check` commands, executed without a shell and with a timeout.
- Explicitly kept arbitrary shell execution, deletion, network access, and automatic Git commits disabled.

## Earlier releases

See the versioned architecture and feature documentation in `docs/` and the repository history.

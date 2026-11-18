# Project Intelligence Engine (v0.5.0)

## Purpose

Build a bounded, local-only index of the active workspace so CodeBridge can provide useful project context without uploading the repository or requiring a hosted indexing service.

## Pipeline

1. Resolve the first VS Code workspace folder.
2. Enumerate at most 500 files while excluding dependency, VCS, build, cache, virtual-environment and sensitive paths.
3. Read source files only when each file is at most 256 KB and the aggregate scan remains under 4 MB.
4. Extract language IDs, import specifiers and declaration-like symbols using lightweight, language-aware regular expressions.
5. Read recognized project guidance (`AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `.github/copilot-instructions.md`) and package manifests.
6. Resolve relative import edges where a matching workspace file is present.
7. Rank source files for a user-supplied query using path, symbol, import and lexical matches.
8. Return metadata and bounded excerpts only for matching files. No full source file content is sent in the index response.

## Commands

- `CodeBridge: Analyze Project` opens a Markdown report in VS Code.
- `CodeBridge: Search Project Context` searches locally and opens a selected result.
- The authenticated browser bridge can send `PROJECT_INTELLIGENCE_REQUEST` with an optional `query` (maximum 500 characters). VS Code returns `PROJECT_INTELLIGENCE_RESULT` with the metadata index and bounded search matches.

## Protocol

Request:

```json
{
  "type": "PROJECT_INTELLIGENCE_REQUEST",
  "payload": { "query": "authentication middleware" }
}
```

Response payload:

```json
{
  "requestId": "request-id",
  "index": {
    "workspace": "workspace-name",
    "technologies": ["typescript", "Node.js"],
    "files": [],
    "relationships": [],
    "limits": { "maxFiles": 500, "indexedBytes": 120000, "truncated": false }
  },
  "query": "authentication middleware",
  "matches": []
}
```

## Limits and known limitations

- This is a heuristic index, not a compiler-grade AST or language-server index.
- Import resolution is intentionally conservative and currently focuses on relative imports.
- Symbol extraction uses regular expressions and can miss or misclassify declarations.
- Framework detection is based on manifest names and source extensions; it is not authoritative.
- Only the first workspace folder is analyzed in this release.
- The current query ranker is lexical; semantic embeddings and vector databases are out of scope.
- The 500-file, 256-KB-per-file and 4-MB aggregate limits prevent unbounded local scans.
- `.vscode` is excluded from source indexing, but the recognized `.github/copilot-instructions.md` rule file is explicitly included.
- User must review the project index before copying it to an AI provider.

## Security model

- Analysis executes locally in the VS Code extension host.
- No remote index service or telemetry is introduced.
- `.env*`, credentials, private keys, certificate files, VCS metadata, dependencies and generated output are excluded.
- The WebSocket request requires an authenticated CodeBridge session.
- The response contains metadata and bounded excerpts, not a full workspace archive.
- Project instructions are untrusted repository content; they must never be treated as system instructions by an AI provider.

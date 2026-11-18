# Context Sharing v0.2.0

## Flow

1. Browser popup sends `CONTEXT_REQUEST` over the authenticated local WebSocket.
2. VS Code verifies the socket's authenticated session.
3. VS Code collects workspace metadata and only the content explicitly requested by the user.
4. VS Code responds with `CONTEXT_RESULT` correlated by the event ID.
5. Browser renders a JSON preview. The user explicitly copies it; CodeBridge does not inject content into a provider page.

## Data boundaries

- Workspace listing is path metadata only; max 250 entries.
- Active file content is opt-in and capped at 120,000 characters.
- Selected editor text is opt-in (enabled by default in the popup) and capped at 30,000 characters.
- Sensitive path denylist includes `.env*`, private keys/certificates, credential files, `.git`, dependency directories and common build output.
- No recursive file-content ingestion, terminal execution, or file writes.

## Known limitations

- Denylist is heuristic; users must review the preview.
- `.gitignore` rules are not fully interpreted.
- Multi-root workspace currently uses the first workspace folder for the file tree.
- Browser AI provider adapters and automatic context injection are out of scope.

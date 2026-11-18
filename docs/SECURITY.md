# Security Design — v0.3.0

## Implemented controls

- WebSocket server binds only to `127.0.0.1` and fixed path `/bridge`.
- WebSocket origin must use the `chrome-extension://` scheme.
- Pairing code and session token use cryptographic randomness; pairing expires after 60 seconds and is single-use.
- VS Code stores its token in `ExtensionContext.secrets`; Chrome stores its token in `chrome.storage.local`.
- Protocol envelopes are validated with Zod; WebSocket frame limit is 1 MiB.
- Workspace context sharing is opt-in and bounded (v0.2.0).
- Provider code transfer is an explicit click on one code block; no full conversation scraping.
- Browser and VS Code reject empty or oversized proposals; proposal size is capped at 200,000 characters.
- Received code opens in an unsaved editor. No workspace file writes, terminal execution, or code execution are performed.

## Known gaps before public production release

- Pin the official Chrome extension ID instead of accepting the `chrome-extension://` scheme generally.
- Add pairing-attempt rate limiting and server-side session revocation.
- Bind authorization scopes to individual message types and add replay protection.
- Add request/response correlation for code proposal delivery receipts.
- Harden DOM adapter behavior against provider page changes and test on real provider accounts.
- Add automated integration tests for Chrome service-worker lifecycle and VS Code WebSocket handling.
- Replace the abbreviated repository license notice with the full official Apache-2.0 license text before public distribution.

## User safety invariant

The extension transfers only the code block selected by the user's explicit click. It never applies code to a project, overwrites files, runs terminal commands, or executes received code. Users must review code before saving or running it.


## Project indexing (v0.5.0)

Indexing runs locally and is bounded to 500 files, 256 KB per file and 4 MB total. Sensitive path patterns and dependency/generated directories are excluded. Browser requests require an authenticated bridge session. Project index output is user-reviewed before sharing. Repository instruction files are untrusted data and must not be elevated to AI system instructions.

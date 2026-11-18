# Architecture — v0.1.0

## Runtime topology

Chrome MV3 service worker <-> WebSocket <-> VS Code Extension Host.

The VS Code extension hosts the bridge server. No standalone daemon is required in v0.1.0.

## Boundaries

- Chrome popup: user interaction only.
- Chrome service worker: socket lifecycle, pairing request, token storage.
- VS Code extension: local server, pairing authority, token storage.
- Protocol package: event envelope and runtime validation.

## Trust boundaries

The browser extension is not trusted merely because it is local. Every incoming message is schema-validated. The WebSocket server binds to loopback and checks the Origin scheme. Only pairing and heartbeat events are supported in this release.

## Future architecture

The next milestone adds context request/response events, explicit file selection, sensitive-file exclusion, and bounded context payloads.


## Context sharing

The VS Code extension is the only component that reads editor/workspace state. The browser requests a bounded context snapshot over the authenticated loopback WebSocket. The popup displays the snapshot and requires an explicit copy action; provider pages are not scraped or modified. See `CONTEXT-SHARING.md`.

## v0.3.0 provider adapter flow

The Chrome content script contains small provider-specific adapters for ChatGPT, Gemini, and Claude. Adapters detect code block DOM nodes and add a user-initiated action. The content script sends the clicked block to the MV3 service worker; the service worker checks bridge authentication and size limits before emitting `AI_CODE_PROPOSAL` over the existing local WebSocket. The VS Code extension validates the event and opens an unsaved editor document. Provider DOM parsing is isolated from the transport and VS Code layers.


## Project Intelligence (v0.5.0)

The VS Code extension performs bounded local workspace scanning in `projectIntelligence.ts`. It extracts manifest summaries, source metadata, symbols and relative import edges. The authenticated browser bridge can request a metadata index and lexical matches through `PROJECT_INTELLIGENCE_REQUEST`. No hosted index or background upload is used. See `PROJECT-INTELLIGENCE.md` for limits and caveats.

# Provider Integration (v0.3.0)

## Design

Provider adapters live in the Chrome content script. They are intentionally isolated from the local bridge and expose only a narrow operation: identify a code block, extract its text and language hint, and offer a button that transfers that one block after a user click.

The adapter does not inspect the full conversation, user prompt, or unrelated page text. It does not automate typing into provider chat boxes and does not use undocumented provider APIs.

## Supported adapters

- ChatGPT: `chatgpt.com` and `chat.openai.com`
- Gemini: `gemini.google.com`
- Claude: `claude.ai`

Each adapter currently uses conservative DOM selectors (`pre`, with `.code-block` as an additional Gemini selector). Provider DOM changes may require selector maintenance. If no code block is detected, the feature remains unavailable on that page; users can still copy code manually.

## Transfer flow

1. The content script detects a code block and adds an **Open in VS Code** button.
2. The user explicitly clicks that button.
3. The content script extracts only the clicked block's text and language hint.
4. The background service worker checks bridge authentication and the 200 KB limit.
5. It sends an `AI_CODE_PROPOSAL` event over the authenticated local WebSocket.
6. The VS Code extension validates the event and opens an unsaved editor document.
7. The user reviews the code and decides whether to save it.

## Protocol

`AI_CODE_PROPOSAL` payload:

```json
{
  "code": "...",
  "language": "typescript",
  "source": "chatgpt",
  "title": "Code proposal from chatgpt"
}
```

The current transfer limit is 200,000 JavaScript characters. The bridge server has a 1 MiB frame limit. The VS Code extension never writes the proposal to a workspace path in v0.3.0.

## Limitations and follow-up

- DOM selectors are not guaranteed by providers and require maintenance.
- The provider adapters do not extract multi-file answers into structured file proposals.
- There is no automatic insertion into provider chat inputs.
- There is no automatic apply, overwrite, terminal execution, or code execution.
- v0.4.0 can introduce structured file proposals, diff preview, explicit Apply/Reject, and conflict checks.

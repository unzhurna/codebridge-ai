# Bridge Protocol — v1.0

Transport: WebSocket  
Endpoint: `ws://127.0.0.1:47831/bridge`  
Encoding: UTF-8 JSON  
Envelope: `protocolVersion`, `id`, `type`, `timestamp`, `source`, `payload`.

## Events implemented

- `PAIR_REQUEST`: browser submits `{ "code": "123456" }`.
- `PAIR_RESULT`: IDE returns `{ "success": true, "sessionToken": "..." }` or failure.
- `AUTH_REQUEST`: browser submits `{ "token": "..." }`.
- `AUTH_RESULT`: IDE returns `{ "success": true|false }`.
- `PING`: either side submits heartbeat.
- `PONG`: receiver returns heartbeat response.
- `AI_CODE_PROPOSAL`: browser sends one explicitly selected provider code block to VS Code.
- `AI_CODE_RESULT`: VS Code acknowledges opening the proposal in an unsaved editor.
- `ERROR`: protocol error.

## Rules

- Reject malformed JSON and invalid envelopes.
- Maximum message payload: 1 MiB.
- Pairing code expires after 60 seconds and is single-use.
- Correlate future request/response events using `id`.
- Never log session tokens or pairing secrets.


## Context sharing (v0.2.0)

### Browser → VS Code: `CONTEXT_REQUEST`

```json
{
  "protocolVersion": "1.0",
  "id": "request-uuid",
  "type": "CONTEXT_REQUEST",
  "timestamp": 1794900000000,
  "source": "browser",
  "payload": { "includeActiveFile": false, "includeSelection": true }
}
```

Only authenticated sockets may request context. `includeActiveFile` is opt-in; `includeSelection` defaults to true in the popup.

### VS Code → Browser: `CONTEXT_RESULT`

The payload contains `requestId`, `context.workspaceName`, `context.activeFile`, optional `context.selection`, optional `context.activeFileContent`, `context.files`, `context.generatedAt`, and `context.limits`. The browser correlates the response to the request ID.

## AI code proposal transfer (v0.3.0)

### Browser → VS Code: `AI_CODE_PROPOSAL`

Sent only after a user clicks the action attached to one detected provider code block. Payload:

```json
{
  "code": "const answer = 42;",
  "language": "typescript",
  "source": "chatgpt",
  "title": "Code proposal from chatgpt"
}
```

The browser background requires an authenticated bridge and rejects empty code or payloads over 200,000 characters. The VS Code extension validates the event, checks authentication again, and opens the code in an unsaved editor. It does not write to a workspace path.

### VS Code → Browser: `AI_CODE_RESULT`

Acknowledges whether a proposal was opened. The current Chrome content action reports the immediate send result; richer delivery receipts and retry correlation are future work.


## Project intelligence

`PROJECT_INTELLIGENCE_REQUEST` accepts an optional `query` string (up to 500 characters). `PROJECT_INTELLIGENCE_RESULT` returns `requestId`, bounded `index` metadata and optional lexical `matches`. Requests require an authenticated session.


## Workflow events (v0.6.0)

All workflow events require an authenticated session.

- `WORKFLOW_CREATE` payload: `{ "instruction": "..." }` (8,000 character maximum).
- `WORKFLOW_UPDATE` payload: `{ "workflowId": "...", "stage": "analyzing" }`. The stage must be a valid transition from the current stage.
- `WORKFLOW_RESULT` payload includes `requestId`, `success`, and either `workflow` plus `summary`, or an error `message`.

See [WORKFLOW-ENGINE.md](WORKFLOW-ENGINE.md) for the state machine and current limitations.


## Agent runtime events (v0.7.0)

- `AGENT_RUN_START`: `{ instruction, maxIterations? }`
- `AGENT_STATUS`: returns run and registered tools
- `AGENT_TOOL_REQUEST`: `{ runId, toolCall: { id?, name, arguments } }`
- `AGENT_TOOL_RESULT`: returns bounded result and updated run
- `AGENT_RUN_STOP`: `{ runId }`

Tool names are allowlisted. See [Agent Runtime](AGENT-RUNTIME.md) for schemas, limits, and security policy.

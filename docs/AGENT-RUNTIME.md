# Agent Runtime v0.7.0

## Scope

The runtime is a bounded, local tool host. The browser AI remains the reasoning/provider surface in this release. CodeBridge does not call private provider APIs and does not run an autonomous LLM loop locally. The browser can request registered tools through the authenticated bridge and use their results in its next model turn.

## Registered tools

| Tool | Capability | Policy |
|---|---|---|
| `workspace.list_files` | List up to 200 non-sensitive workspace paths | Read-only |
| `workspace.read_file` | Read one file, maximum 30,000 characters | Read-only |
| `workspace.search_text` | Search bounded workspace files, maximum 30 matches | Read-only |
| `workspace.get_diagnostics` | Read current VS Code diagnostics | Read-only |

## Run lifecycle

`AGENT_RUN_START` creates a run with an iteration budget (1–12). `AGENT_TOOL_REQUEST` invokes one registered tool. `AGENT_TOOL_RESULT` returns a bounded result and updated run state. `AGENT_RUN_STOP` stops the run. Each request is authenticated by the existing bridge session.

## Safety boundaries

- No terminal, shell, process, arbitrary JavaScript, network, write, delete, or install tool is registered.
- Unknown tool names are rejected.
- File paths must be relative and remain inside the active workspace.
- Sensitive paths and generated/dependency folders are excluded.
- File reads are limited to 30,000 characters; search results to 30 entries; tool output to 60,000 serialized characters.
- Agent runs are in-memory and are lost when the VS Code extension host restarts.
- Read-only tools are currently allowed automatically after authenticated requests. Any future mutating or execution tool must be added behind a separate explicit VS Code approval prompt; browser-side approval alone is not sufficient.

## Current limitations

This is a tool runtime and protocol foundation, not a fully autonomous agent. The user still interacts with ChatGPT, Gemini, or Claude in the browser. Provider-specific DOM changes may affect the existing code-block transfer flow. The Chrome popup does not yet provide a dedicated agent chat/task console; tool requests are sent by a compatible browser-side client.

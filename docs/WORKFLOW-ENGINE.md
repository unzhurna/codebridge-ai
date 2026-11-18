# CodeBridge AI v0.6.0 — Workflow Engine

## Purpose

The workflow engine introduces a local, explicit lifecycle for development tasks. It does not claim to be an autonomous coding agent and does not call ChatGPT, Gemini, or Claude APIs. Planning in this release is deterministic and local; provider output remains user-mediated through the browser integration.

## Lifecycle

`planned → analyzing → proposed → reviewing → applying → completed`

Alternative terminal states: `rejected`, `cancelled`, `failed`. A failed workflow may return to `analyzing`. Invalid transitions are rejected by the state machine.

## VS Code commands

- `CodeBridge: Create AI Development Workflow` — enter an instruction and create a local plan.
- `CodeBridge: Update Workflow Stage` — choose a valid next stage.
- `CodeBridge: Update Workflow Task` — update an individual task status.

Workflow records are held in memory for the current VS Code extension session in v0.6.0. They are not persisted across reloads yet.

## Bridge protocol

- `WORKFLOW_CREATE`: authenticated browser request with `{ instruction: string }`.
- `WORKFLOW_RESULT`: returns the workflow and progress summary.
- `WORKFLOW_UPDATE`: authenticated request with `{ workflowId: string, stage: string }`.

All requests are validated by the shared event envelope and require an authenticated bridge session. Workflow instructions are limited to 8,000 characters.

## Approval and execution boundaries

This release does not execute shell commands, run tests, modify files as part of planning, or autonomously apply a proposal. Applying code remains the separate v0.4.0 proposal flow, with explicit VS Code confirmation. A workflow stage named `applying` is a tracking state, not permission to write files.

## Current limitations

- Planner uses deterministic keyword-based task templates, not an LLM.
- No provider API keys or cloud backend are used.
- No durable workflow database or cross-device sync.
- No autonomous command execution or background agent loop.
- Workflow updates are session-scoped and local to VS Code.

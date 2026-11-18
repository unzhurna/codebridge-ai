import { randomUUID } from "node:crypto";

export type AgentRunStatus = "idle" | "running" | "waiting_approval" | "completed" | "stopped" | "failed";
export type AgentToolName = "workspace.list_files" | "workspace.read_file" | "workspace.search_text" | "workspace.get_diagnostics" | "workspace.write_file" | "workspace.apply_files" | "workspace.git_status" | "workspace.git_diff_check";
export type AgentToolRisk = "read_only" | "write" | "execute";

export interface AgentToolCall { id: string; name: AgentToolName; arguments: Record<string, unknown>; }
export interface AgentToolDefinition { name: AgentToolName; description: string; risk: AgentToolRisk; requiresApproval: boolean; }
export interface AgentRun { id: string; instruction: string; status: AgentRunStatus; iteration: number; maxIterations: number; createdAt: string; updatedAt: string; lastToolCall?: AgentToolCall; lastResult?: unknown; error?: string; }

export const AGENT_TOOLS: AgentToolDefinition[] = [
  { name: "workspace.list_files", description: "List non-sensitive files in the active workspace.", risk: "read_only", requiresApproval: false },
  { name: "workspace.read_file", description: "Read a bounded, non-sensitive workspace file.", risk: "read_only", requiresApproval: false },
  { name: "workspace.search_text", description: "Search text in non-sensitive workspace files.", risk: "read_only", requiresApproval: false },
  { name: "workspace.get_diagnostics", description: "Read current VS Code diagnostics for workspace files.", risk: "read_only", requiresApproval: false },
  { name: "workspace.write_file", description: "Create or replace one workspace file after an explicit VS Code approval and diff review.", risk: "write", requiresApproval: true },
  { name: "workspace.apply_files", description: "Apply a bounded multi-file transaction after one explicit approval, preflight validation, and diff review.", risk: "write", requiresApproval: true },
  { name: "workspace.git_status", description: "Run the fixed, read-only git status --short command after explicit user approval.", risk: "execute", requiresApproval: true },
  { name: "workspace.git_diff_check", description: "Run the fixed, read-only git diff --check command after explicit user approval.", risk: "execute", requiresApproval: true }
];

export const MAX_AGENT_ITERATIONS = 12;
export const MAX_TOOL_RESULT_CHARS = 60_000;
export const MAX_READ_FILE_CHARS = 30_000;
export const MAX_SEARCH_RESULTS = 30;

export function createAgentRun(instruction: string, maxIterations = MAX_AGENT_ITERATIONS): AgentRun {
  const clean = instruction.trim().replace(/\s+/g, " ");
  if (clean.length < 8) throw new Error("Agent instruction must contain at least 8 characters.");
  if (clean.length > 8_000) throw new Error("Agent instruction exceeds the 8,000 character limit.");
  const now = new Date().toISOString();
  return { id: randomUUID(), instruction: clean, status: "running", iteration: 0, maxIterations: Math.min(Math.max(Math.floor(maxIterations), 1), MAX_AGENT_ITERATIONS), createdAt: now, updatedAt: now };
}

export function validateToolCall(value: unknown): AgentToolCall {
  if (!value || typeof value !== "object") throw new Error("Tool call must be an object.");
  const input = value as Record<string, unknown>;
  const definition = AGENT_TOOLS.find((tool) => tool.name === input.name);
  if (!definition) throw new Error("Unknown or disabled agent tool.");
  if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw new Error("Tool arguments must be an object.");
  const id = typeof input.id === "string" && input.id.length <= 128 ? input.id : randomUUID();
  return { id, name: definition.name, arguments: input.arguments as Record<string, unknown> };
}

export function beginToolCall(run: AgentRun, call: AgentToolCall): AgentRun {
  if (run.status !== "running") throw new Error("Agent run is not active.");
  if (run.iteration >= run.maxIterations) throw new Error("Agent iteration limit reached.");
  return { ...run, iteration: run.iteration + 1, lastToolCall: call, updatedAt: new Date().toISOString() };
}

export function finishAgentRun(run: AgentRun, status: AgentRunStatus, result?: unknown, error?: string): AgentRun {
  if (!["completed", "stopped", "failed", "waiting_approval", "running"].includes(status)) throw new Error("Invalid agent status.");
  return { ...run, status, lastResult: result, error, updatedAt: new Date().toISOString() };
}

export function boundToolResult(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return value;
  return { truncated: true, message: "Tool result exceeded the output limit.", preview: serialized.slice(0, MAX_TOOL_RESULT_CHARS) };
}

import * as vscode from "vscode";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile as readNodeFile, rename, writeFile as writeNodeFile } from "node:fs/promises";
import { AGENT_TOOLS, MAX_READ_FILE_CHARS, MAX_SEARCH_RESULTS, beginToolCall, boundToolResult, createAgentRun, finishAgentRun, validateToolCall, type AgentRun } from "./agentRuntime";
import path from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import { analyzeAndShow, buildProjectIndex, searchProjectIndex } from "./projectIntelligence";
import { createWorkflowPlan, transitionWorkflow, updateTask, workflowSummary, type WorkflowRecord, type WorkflowStage } from "./workflow";
import { WebSocketServer, WebSocket } from "ws";
import {
  BRIDGE_HOST,
  BRIDGE_PATH,
  BRIDGE_PORT,
  bridgeEventSchema,
  createEvent
} from "@codebridge/protocol";

const execFileAsync = promisify(execFile);
const TOKEN_SECRET_KEY = "codebridge.sessionToken";
const ROLLBACK_MANIFEST = "agent-rollback-v1.json";
const MAX_TRANSACTION_FILES = 10;
const MAX_TRANSACTION_CHARS = 500_000;
const PAIRING_TTL_MS = 60_000;

let server: WebSocketServer | undefined;
let pairingCode: string | undefined;
let pairingExpiresAt = 0;
let sessionToken: string | undefined;
let statusItem: vscode.StatusBarItem;
let latestRollback: Array<{ uri: vscode.Uri; existed: boolean; content?: Uint8Array }> = [];
const workflows = new Map<string, WorkflowRecord>();
let activeWorkflowId: string | undefined;
const agentRuns = new Map<string, AgentRun>();
let activeAgentRunId: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
const AGENT_STATE_KEY = "codebridge.agentState.v1";
const AGENT_AUDIT_KEY = "codebridge.agentAudit.v1";
type AgentAuditEntry = { id: string; at: string; runId: string; action: string; detail: string; outcome: "approved" | "rejected" | "completed" | "failed" | "stopped" };
let agentAudit: AgentAuditEntry[] = [];

async function persistAgentState(): Promise<void> {
  if (!extensionContext) return;
  const safeRuns = [...agentRuns.values()].slice(-50).map((run) => ({
    id: run.id,
    instruction: run.instruction,
    status: run.status,
    iteration: run.iteration,
    maxIterations: run.maxIterations,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    error: run.error
  }));
  await extensionContext.globalState.update(AGENT_STATE_KEY, { runs: safeRuns, activeAgentRunId });
  await extensionContext.globalState.update(AGENT_AUDIT_KEY, agentAudit.slice(-500));
}

function auditAgent(runId: string, action: string, detail: string, outcome: AgentAuditEntry["outcome"]): void {
  agentAudit.push({ id: randomBytes(12).toString("hex"), at: new Date().toISOString(), runId, action, detail: detail.slice(0, 500), outcome });
  agentAudit = agentAudit.slice(-500);
  void persistAgentState();
}

function makeToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(ws: WebSocket, type: Parameters<typeof createEvent>[0], payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(createEvent(type, "vscode", payload)));
  }
}

function setStatus(connected: boolean): void {
  statusItem.text = connected ? "$(plug) CodeBridge: Ready" : "$(plug) CodeBridge: Offline";
  statusItem.tooltip = connected
    ? "CodeBridge local bridge is running"
    : "CodeBridge local bridge is stopped";
}

async function startBridge(context: vscode.ExtensionContext): Promise<void> {
  if (server) return;

  const configuredPort = vscode.workspace.getConfiguration("codebridge").get<number>("port", BRIDGE_PORT);
  sessionToken = await context.secrets.get(TOKEN_SECRET_KEY);

  server = new WebSocketServer({
    host: BRIDGE_HOST,
    port: configuredPort,
    path: BRIDGE_PATH,
    maxPayload: 1024 * 1024,
    verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("chrome-extension://")
  });

  server.on("listening", () => {
    setStatus(true);
    vscode.window.showInformationMessage(`CodeBridge local bridge listening on ${BRIDGE_HOST}:${configuredPort}`);
  });

  server.on("error", (error) => {
    vscode.window.showErrorMessage(`CodeBridge bridge error: ${error.message}`);
    setStatus(false);
    server?.close();
    server = undefined;
  });

  server.on("connection", (ws) => {
    let authenticated = false;
    ws.on("message", async (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(ws, "ERROR", { code: "INVALID_JSON", message: "Message must be valid JSON." });
        return;
      }

      const result = bridgeEventSchema.safeParse(parsed);
      if (!result.success) {
        send(ws, "ERROR", { code: "INVALID_MESSAGE", message: "Message schema validation failed." });
        return;
      }

      const message = result.data;

      if (message.type === "PAIR_REQUEST") {
        const suppliedCode = message.payload.code;
        const valid = typeof suppliedCode === "string"
          && pairingCode !== undefined
          && Date.now() <= pairingExpiresAt
          && secureEqual(suppliedCode.replace(/\s/g, ""), pairingCode);

        if (!valid) {
          send(ws, "PAIR_RESULT", { success: false, code: "PAIRING_INVALID" });
          return;
        }

        sessionToken = makeToken();
        authenticated = true;
        await context.secrets.store(TOKEN_SECRET_KEY, sessionToken);
        pairingCode = undefined;
        pairingExpiresAt = 0;
        send(ws, "PAIR_RESULT", { success: true, sessionToken });
        vscode.window.showInformationMessage("CodeBridge browser paired successfully.");
        return;
      }

      if (message.type === "AUTH_REQUEST") {
        const suppliedToken = message.payload.token;
        const valid = typeof suppliedToken === "string"
          && typeof sessionToken === "string"
          && secureEqual(suppliedToken, sessionToken);
        authenticated = valid;
        send(ws, "AUTH_RESULT", { success: valid });
        return;
      }

      if (message.type === "CONTEXT_REQUEST") {
        if (!authenticated) {
          send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before requesting workspace context." });
          return;
        }
        const includeActiveFile = message.payload.includeActiveFile === true;
        const includeSelection = message.payload.includeSelection !== false;
        const context = await collectWorkspaceContext({ includeActiveFile, includeSelection });
        send(ws, "CONTEXT_RESULT", { requestId: message.id, context });
        return;
      }

      if (message.type === "PROJECT_INTELLIGENCE_REQUEST") {
        if (!authenticated) {
          send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before requesting project intelligence." });
          return;
        }
        try {
          const { index, internalFiles } = await buildProjectIndex();
          const query = typeof message.payload.query === "string" ? message.payload.query.slice(0, 500) : "";
          const matches = query ? searchProjectIndex(internalFiles, query) : [];
          send(ws, "PROJECT_INTELLIGENCE_RESULT", {
            requestId: message.id,
            index,
            query,
            matches
          });
        } catch (error) {
          send(ws, "ERROR", { code: "PROJECT_ANALYSIS_FAILED", message: error instanceof Error ? error.message : "Project analysis failed." });
        }
        return;
      }

      if (message.type === "WORKFLOW_CREATE") {
        if (!authenticated) {
          send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before creating a workflow." });
          return;
        }
        try {
          const instruction = typeof message.payload.instruction === "string" ? message.payload.instruction : "";
          const workflow = createWorkflowPlan(instruction);
          workflows.set(workflow.id, workflow);
          activeWorkflowId = workflow.id;
          send(ws, "WORKFLOW_RESULT", { requestId: message.id, success: true, workflow, summary: workflowSummary(workflow) });
        } catch (error) {
          send(ws, "WORKFLOW_RESULT", { requestId: message.id, success: false, message: error instanceof Error ? error.message : "Workflow planning failed." });
        }
        return;
      }

      if (message.type === "WORKFLOW_UPDATE") {
        if (!authenticated) {
          send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before updating a workflow." });
          return;
        }
        try {
          const id = typeof message.payload.workflowId === "string" ? message.payload.workflowId : "";
          const current = workflows.get(id);
          if (!current) throw new Error("Workflow not found in this VS Code session.");
          const next = message.payload.stage;
          if (typeof next !== "string") throw new Error("A workflow stage is required.");
          const updated = transitionWorkflow(current, next as WorkflowStage);
          workflows.set(id, updated);
          send(ws, "WORKFLOW_RESULT", { requestId: message.id, success: true, workflow: updated, summary: workflowSummary(updated) });
        } catch (error) {
          send(ws, "WORKFLOW_RESULT", { requestId: message.id, success: false, message: error instanceof Error ? error.message : "Workflow update failed." });
        }
        return;
      }

      if (message.type === "AGENT_RUN_START") {
        if (!authenticated) { send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before starting an agent run." }); return; }
        try {
          const instruction = typeof message.payload.instruction === "string" ? message.payload.instruction : "";
          const run = createAgentRun(instruction, typeof message.payload.maxIterations === "number" ? message.payload.maxIterations : 12);
          agentRuns.set(run.id, run); activeAgentRunId = run.id; await persistAgentState();
          send(ws, "AGENT_STATUS", { requestId: message.id, run, tools: AGENT_TOOLS });
        } catch (error) { send(ws, "AGENT_STATUS", { requestId: message.id, success: false, message: error instanceof Error ? error.message : "Could not start agent run." }); }
        return;
      }

      if (message.type === "AGENT_RUN_STOP") {
        if (!authenticated) { send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before stopping an agent run." }); return; }
        const runId = typeof message.payload.runId === "string" ? message.payload.runId : activeAgentRunId;
        const run = runId ? agentRuns.get(runId) : undefined;
        if (!run) { send(ws, "AGENT_STATUS", { requestId: message.id, success: false, message: "Agent run not found." }); return; }
        const stopped = finishAgentRun(run, "stopped"); agentRuns.set(stopped.id, stopped); auditAgent(stopped.id, "agent.stop", "Stopped by user", "stopped"); await persistAgentState();
        send(ws, "AGENT_STATUS", { requestId: message.id, run: stopped }); return;
      }

      if (message.type === "AGENT_TOOL_REQUEST") {
        if (!authenticated) { send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before requesting agent tools." }); return; }
        try {
          const runId = typeof message.payload.runId === "string" ? message.payload.runId : "";
          const current = agentRuns.get(runId); if (!current) throw new Error("Agent run not found.");
          const call = validateToolCall(message.payload.toolCall);
          const nextRun = beginToolCall(current, call); agentRuns.set(runId, nextRun);
          const result = call.name === "workspace.write_file"
            ? await executeApprovedWriteTool(runId, call.arguments)
            : call.name === "workspace.apply_files"
              ? await executeApprovedApplyFilesTool(runId, call.arguments)
              : call.name === "workspace.git_status" || call.name === "workspace.git_diff_check"
                ? await runApprovedGitCommand(runId, call.name)
                : await executeReadOnlyAgentTool(call.name, call.arguments);
          const bounded = boundToolResult(result);
          const updated = finishAgentRun(nextRun, "running", bounded); agentRuns.set(runId, updated);
          await persistAgentState();
          send(ws, "AGENT_TOOL_RESULT", { requestId: message.id, runId, toolCallId: call.id, success: true, result: bounded, run: updated });
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "Agent tool failed.";
          const failedRunId = typeof message.payload.runId === "string" ? message.payload.runId : "";
          if (failedRunId) auditAgent(failedRunId, "agent.tool", messageText, "failed");
          await persistAgentState();
          send(ws, "AGENT_TOOL_RESULT", { requestId: message.id, success: false, message: messageText });
        }
        return;
      }

      if (message.type === "AI_CODE_PROPOSAL") {
        if (!authenticated) {
          send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before sending code proposals." });
          return;
        }
        try {
          const result = await reviewCodeProposal(message.payload);
          send(ws, "PROPOSAL_RESULT", { requestId: message.id, ...result });
        } catch (error) {
          send(ws, "PROPOSAL_RESULT", { requestId: message.id, success: false, message: error instanceof Error ? error.message : "Proposal could not be reviewed." });
        }
        return;
      }

      if (message.type === "AGENT_SESSION_LIST") {
        if (!authenticated) { send(ws, "ERROR", { code: "UNAUTHORIZED", message: "Authenticate before listing agent sessions." }); return; }
        send(ws, "AGENT_SESSION_LIST", { requestId: message.id, runs: [...agentRuns.values()].slice(-50), audit: agentAudit.slice(-100) });
        return;
      }

      if (message.type === "PING") {
        send(ws, "PONG", { at: Date.now() });
      }
    });

    ws.on("error", () => undefined);
  });

  context.subscriptions.push({
    dispose: () => {
      server?.close();
      server = undefined;
    }
  });
}

type TransactionFile = { path: string; content: string };
type TransactionSnapshot = { workspaceRoot: string; createdAt: string; files: Array<{ path: string; existed: boolean; beforeBase64?: string; beforeHash: string; afterHash: string }> };

function validateWorkspaceRelativePath(relativeInput: string): string {
  const relative = relativeInput.replace(/\\/g, "/");
  if (!relative || relative.length > 500 || relative.startsWith("/") || /^[a-z]:/i.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe workspace-relative path.");
  if (BLOCKED_PATH.test(relative) || relative.split("/").some((part) => [".git", "node_modules", "vendor", "dist", "build", ".vscode"].includes(part))) throw new Error("Target path is protected.");
  return relative;
}

async function executeApprovedApplyFilesTool(runId: string, args: Record<string, unknown>): Promise<unknown> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace || !extensionContext) throw new Error("Open a workspace folder before requesting a multi-file apply.");
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > MAX_TRANSACTION_FILES) throw new Error(`files must contain between 1 and ${MAX_TRANSACTION_FILES} entries.`);
  const files: TransactionFile[] = args.files.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each transaction file must be an object.");
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.path !== "string" || typeof candidate.content !== "string") throw new Error("Each transaction file requires string path and content.");
    return { path: validateWorkspaceRelativePath(candidate.path), content: candidate.content };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("A transaction cannot contain duplicate paths.");
  const totalChars = files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalChars > MAX_TRANSACTION_CHARS) throw new Error("Multi-file transaction exceeds the 500,000 character limit.");

  const rootReal = await realpath(workspace.uri.fsPath);
  const prepared: Array<{ file: TransactionFile; uri: vscode.Uri; existed: boolean; before: Uint8Array; after: Uint8Array; beforeHash: string }> = [];
  for (const file of files) {
    const uri = vscode.Uri.joinPath(workspace.uri, file.path);
    const parent = vscode.Uri.joinPath(uri, "..");
    const parentReal = await realpath(parent.fsPath);
    const parentRelative = path.relative(rootReal, parentReal);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new Error(`Parent directory escapes workspace: ${file.path}`);
    let existed = false;
    let before = new Uint8Array();
    try {
      const linkInfo = await lstat(uri.fsPath);
      if (linkInfo.isSymbolicLink()) throw new Error(`Symbolic-link targets are not writable: ${file.path}`);
      const targetReal = await realpath(uri.fsPath);
      const targetRelative = path.relative(rootReal, targetReal);
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error(`Target escapes workspace: ${file.path}`);
      const metadata = await stat(targetReal);
      if (!metadata.isFile() || metadata.size > 1_000_000) throw new Error(`Target is not a regular file or exceeds 1 MB: ${file.path}`);
      before = await vscode.workspace.fs.readFile(uri);
      existed = true;
    } catch (error) {
      if (error instanceof Error && /Symbolic-link|escapes workspace|regular file|exceeds 1 MB/.test(error.message)) throw error;
      // A missing file is allowed only when its parent already exists.
    }
    const after = new TextEncoder().encode(file.content);
    prepared.push({ file, uri, existed, before, after, beforeHash: sha256(before) });
  }

  for (const item of prepared) {
    const beforeDoc = item.existed ? await vscode.workspace.openTextDocument(item.uri) : await vscode.workspace.openTextDocument({ language: "plaintext", content: "" });
    const afterDoc = await vscode.workspace.openTextDocument({ language: beforeDoc.languageId, content: item.file.content });
    await vscode.commands.executeCommand("vscode.diff", beforeDoc.uri, afterDoc.uri, `CodeBridge Transaction: ${item.file.path}`, { preview: false });
  }
  const decision = await vscode.window.showWarningMessage(
    `Apply ${prepared.length} file changes as one transaction?`,
    { modal: true, detail: `Agent run ${runId}. Review every diff. All targets will be revalidated before writing. If a write fails, already-written files will be restored.` },
    "Approve transaction", "Reject"
  );
  if (decision !== "Approve transaction") {
    auditAgent(runId, "workspace.apply_files", `${prepared.length} files`, "rejected");
    return { approved: false, files: prepared.map((item) => item.file.path), message: "Transaction rejected; no files were changed." };
  }

  // Revalidate every target before the first write to prevent partial application on stale input.
  for (const item of prepared) {
    let current = new Uint8Array();
    let existsNow = true;
    try {
      const linkInfo = await lstat(item.uri.fsPath);
      if (linkInfo.isSymbolicLink()) throw new Error(`Target changed to a symbolic link: ${item.file.path}`);
      const targetReal = await realpath(item.uri.fsPath);
      const targetRelative = path.relative(rootReal, targetReal);
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error(`Target changed to an external path: ${item.file.path}`);
      current = await vscode.workspace.fs.readFile(item.uri);
    } catch (error) {
      if (error instanceof Error && /symbolic link|external path/.test(error.message)) throw error;
      existsNow = false;
    }
    if (existsNow !== item.existed || (existsNow && sha256(current) !== item.beforeHash)) throw new Error(`Conflict detected for ${item.file.path}; no transaction writes were started.`);
  }

  const manifest: TransactionSnapshot = {
    workspaceRoot: rootReal,
    createdAt: new Date().toISOString(),
    files: prepared.map((item) => ({ path: item.file.path, existed: item.existed, beforeBase64: item.existed ? Buffer.from(item.before).toString("base64") : undefined, beforeHash: item.beforeHash, afterHash: sha256(item.after) }))
  };
  const storageDir = extensionContext.globalStorageUri.fsPath;
  await mkdir(storageDir, { recursive: true });
  const manifestPath = path.join(storageDir, ROLLBACK_MANIFEST);
  const tempManifestPath = `${manifestPath}.tmp`;
  await writeNodeFile(tempManifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await rename(tempManifestPath, manifestPath);

  const applied: typeof prepared = [];
  try {
    for (const item of prepared) {
      await vscode.workspace.fs.writeFile(item.uri, item.after);
      applied.push(item);
    }
  } catch (error) {
    for (const item of [...applied].reverse()) {
      try {
        if (item.existed) await vscode.workspace.fs.writeFile(item.uri, item.before);
        else await vscode.workspace.fs.delete(item.uri);
      } catch { /* Preserve the original failure; recovery snapshot remains available. */ }
    }
    auditAgent(runId, "workspace.apply_files", `${applied.length}/${prepared.length} files`, "failed");
    throw new Error(`Transaction failed and automatic recovery was attempted: ${error instanceof Error ? error.message : "unknown write error"}`);
  }
  auditAgent(runId, "workspace.apply_files", prepared.map((item) => item.file.path).join(", "), "approved");
  return { approved: true, transactionId: path.basename(manifestPath), files: prepared.map((item) => ({ path: item.file.path, bytesWritten: item.after.byteLength })), rollbackAvailable: true };
}

async function runApprovedGitCommand(runId: string, toolName: string): Promise<unknown> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) throw new Error("Open a workspace folder first.");
  const commands: Record<string, { args: string[]; title: string; detail: string }> = {
    "workspace.git_status": { args: ["status", "--short"], title: "Git status", detail: "Read-only git status --short" },
    "workspace.git_diff_check": { args: ["diff", "--check"], title: "Git diff check", detail: "Read-only git diff --check" }
  };
  const selected = commands[toolName];
  if (!selected) throw new Error("Command is not in the CodeBridge fixed command allowlist.");
  const decision = await vscode.window.showWarningMessage(`Run ${selected.title}?`, { modal: true, detail: `${selected.detail}\nNo shell is used. Arguments are fixed by CodeBridge.` }, "Approve command", "Reject");
  if (decision !== "Approve command") {
    auditAgent(runId, toolName, selected.detail, "rejected");
    return { approved: false, message: "Command rejected by user." };
  }
  const result = await execFileAsync("git", selected.args, { cwd: workspace.uri.fsPath, timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true });
  auditAgent(runId, toolName, selected.detail, "approved");
  return { command: `git ${selected.args.join(" ")}`, stdout: result.stdout.slice(0, 20_000), stderr: result.stderr.slice(0, 5_000) };
}

async function executeReadOnlyAgentTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) throw new Error("Open a workspace folder first.");
  const blocked = (relative: string) => isExcluded(relative) || relative.split(/[\\/]/).some((part) => part === ".git" || part === "node_modules" || part === "vendor");
  if (name === "workspace.list_files") {
    const uris = await vscode.workspace.findFiles("**/*", "**/{.git,node_modules,vendor,dist,build,coverage}/**", 300);
    return uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).filter((item) => !blocked(item)).slice(0, 200);
  }
  if (name === "workspace.read_file") {
    const relative = typeof args.path === "string" ? args.path : "";
    if (!relative || relative.startsWith("/") || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || blocked(relative)) throw new Error("Invalid or protected file path.");
    const uri = vscode.Uri.joinPath(workspace.uri, relative);
    const rootRealPath = await realpath(workspace.uri.fsPath);
    const targetRealPath = await realpath(uri.fsPath);
    const rel = path.relative(rootRealPath, targetRealPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("File path escapes workspace (including symlinks).");
    const metadata = await stat(targetRealPath);
    if (!metadata.isFile()) throw new Error("Only regular files can be read by the agent.");
    if (metadata.size > 256_000) throw new Error("File exceeds the 256 KB agent read limit.");
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes);
    return { path: relative, content: text.slice(0, MAX_READ_FILE_CHARS), truncated: text.length > MAX_READ_FILE_CHARS };
  }
  if (name === "workspace.search_text") {
    const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
    if (query.length < 2) throw new Error("Search query must contain at least 2 characters.");
    const uris = await vscode.workspace.findFiles("**/*", "**/{.git,node_modules,vendor,dist,build,coverage}/**", 500);
    const matches: Array<{ path: string; line: number; excerpt: string }> = [];
    for (const uri of uris) {
      const relative = vscode.workspace.asRelativePath(uri, false); if (blocked(relative)) continue;
      try { const raw = await vscode.workspace.fs.readFile(uri); if (raw.byteLength > 256_000) continue;
        const content = new TextDecoder().decode(raw); const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => { if (line.toLowerCase().includes(query.toLowerCase()) && matches.length < MAX_SEARCH_RESULTS) matches.push({ path: relative, line: index + 1, excerpt: line.trim().slice(0, 300) }); });
      } catch { /* Ignore unreadable or binary files. */ }
      if (matches.length >= MAX_SEARCH_RESULTS) break;
    }
    return { query, matches };
  }
  if (name === "workspace.get_diagnostics") {
    return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => {
      const relative = vscode.workspace.asRelativePath(uri, false); if (blocked(relative)) return [];
      return diagnostics.slice(0, 100).map((item) => ({ path: relative, severity: vscode.DiagnosticSeverity[item.severity], message: item.message.slice(0, 500), line: item.range.start.line + 1, source: item.source }));
    }).slice(0, 200);
  }
  throw new Error("Tool is not registered.");
}

async function executeApprovedWriteTool(runId: string, args: Record<string, unknown>): Promise<unknown> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) throw new Error("Open a workspace folder before requesting a file write.");
  const relative = typeof args.path === "string" ? args.path.replace(/\\/g, "/") : "";
  const content = typeof args.content === "string" ? args.content : undefined;
  if (!relative || content === undefined) throw new Error("workspace.write_file requires string path and content arguments.");
  if (relative.length > 500 || content.length > 100_000) throw new Error("Write request exceeds path or 100 KB content limit.");
  if (relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe workspace-relative path.");
  if (BLOCKED_PATH.test(relative) || relative.split("/").some((part) => [".git", "node_modules", "vendor", "dist", "build", ".vscode"].includes(part))) throw new Error("Target path is protected.");

  const uri = vscode.Uri.joinPath(workspace.uri, relative);
  const rootReal = await realpath(workspace.uri.fsPath);
  try {
    const linkInfo = await lstat(uri.fsPath);
    if (linkInfo.isSymbolicLink()) throw new Error("Symbolic-link targets are not writable by the agent.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("Symbolic-link")) throw error;
    // A missing target is allowed; its existing parent is checked below.
  }
  let existed = false;
  let before = new Uint8Array();
  try {
    const targetReal = await realpath(uri.fsPath);
    const rel = path.relative(rootReal, targetReal);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Target symlink escapes workspace.");
    const metadata = await stat(targetReal);
    if (!metadata.isFile()) throw new Error("Only regular files can be replaced.");
    if (metadata.size > 1_000_000) throw new Error("Existing file exceeds the 1 MB write safety limit.");
    before = await vscode.workspace.fs.readFile(uri);
    existed = true;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("escapes") || error.message.includes("regular") || error.message.includes("safety limit"))) throw error;
    const parent = vscode.Uri.joinPath(uri, "..");
    const parentReal = await realpath(parent.fsPath);
    const rel = path.relative(rootReal, parentReal);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Target parent escapes workspace.");
  }

  const beforeHash = sha256(before);
  const after = new TextEncoder().encode(content);
  const beforeDoc = existed ? await vscode.workspace.openTextDocument(uri) : await vscode.workspace.openTextDocument({ language: "plaintext", content: "" });
  const afterDoc = await vscode.workspace.openTextDocument({ language: beforeDoc.languageId, content });
  await vscode.commands.executeCommand("vscode.diff", beforeDoc.uri, afterDoc.uri, `CodeBridge Approval: ${relative}`, { preview: false });
  const decision = await vscode.window.showWarningMessage(
    `${existed ? "Replace" : "Create"} ${relative}?`,
    { modal: true, detail: `Agent run ${runId}. Review the diff before approving. CodeBridge will re-check the file immediately before writing.` },
    "Approve write", "Reject"
  );
  if (decision !== "Approve write") {
    auditAgent(runId, "workspace.write_file", relative, "rejected");
    return { approved: false, path: relative, message: "User rejected the file write. No file was changed." };
  }

  let current = new Uint8Array();
  let existsNow = true;
  try {
    const targetReal = await realpath(uri.fsPath);
    const targetRelative = path.relative(rootReal, targetReal);
    if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error("Target changed to a symlink outside the workspace.");
    const linkInfo = await lstat(uri.fsPath);
    if (linkInfo.isSymbolicLink()) throw new Error("Target changed to a symbolic link.");
    current = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (error instanceof Error && (error.message.includes("symlink") || error.message.includes("symbolic link"))) throw error;
    existsNow = false;
  }
  if (existsNow !== existed || (existsNow && sha256(current) !== beforeHash)) {
    auditAgent(runId, "workspace.write_file", relative, "failed");
    throw new Error("Write conflict: target changed after approval preview. No write was performed.");
  }
  latestRollback = [{ uri, existed, content: existed ? before : undefined }];
  await vscode.workspace.fs.writeFile(uri, after);
  auditAgent(runId, "workspace.write_file", relative, "approved");
  return { approved: true, path: relative, bytesWritten: after.byteLength, rollbackAvailable: true };
}

type ProposedFile = { path: string; content: string };
type RollbackEntry = { uri: vscode.Uri; existed: boolean; content?: Uint8Array };
const MAX_PROPOSAL_FILES = 10;
const MAX_PROPOSAL_CHARS = 500_000;
const BLOCKED_PATH = /(^|\/)(\.env(?:\..*)?|.*\.(pem|key|p12|pfx|crt|cer)|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.(json|ya?ml))$/i;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveProposalFiles(payload: Record<string, unknown>): { title: string; files: ProposedFile[] } {
  const title = typeof payload.title === "string" ? payload.title.slice(0, 160) : "AI code proposal";
  let files: ProposedFile[] = [];
  if (Array.isArray(payload.files)) {
    files = payload.files.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Each proposal file must be an object.");
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.path !== "string" || typeof candidate.content !== "string") throw new Error("Each proposal file needs string path and content fields.");
      return { path: candidate.path, content: candidate.content };
    });
  } else if (typeof payload.code === "string") {
    throw new Error("A target path is required. Send files: [{ path, content }] in the proposal payload.");
  }
  if (!files.length || files.length > MAX_PROPOSAL_FILES) throw new Error(`Proposal must contain 1–${MAX_PROPOSAL_FILES} files.`);
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_PROPOSAL_CHARS) throw new Error("Proposal exceeds the 500,000 character limit.");
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe relative path: ${file.path}`);
    if (BLOCKED_PATH.test(normalized) || normalized.split("/").some((part) => [".git", "node_modules", "vendor", "dist", "build"].includes(part))) throw new Error(`Protected path is excluded: ${file.path}`);
    if (seen.has(normalized)) throw new Error(`Duplicate target path: ${file.path}`);
    seen.add(normalized);
    file.path = normalized;
  }
  return { title, files };
}

async function reviewCodeProposal(payload: Record<string, unknown>): Promise<{ success: boolean; applied?: number; message: string }> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) throw new Error("Open a workspace folder before applying a code proposal.");
  let normalizedPayload = payload;
  if (!Array.isArray(payload.files) && typeof payload.code === "string") {
    try {
      const structured = JSON.parse(payload.code) as Record<string, unknown>;
      if (Array.isArray(structured.files)) normalizedPayload = structured;
    } catch { /* A normal code block needs a user-selected target file. */ }
  }
  if (!Array.isArray(normalizedPayload.files) && typeof payload.code === "string") {
    const targets = await vscode.workspace.findFiles("**/*", "**/{.git,node_modules,vendor,dist,build}/**", 500);
    const selected = await vscode.window.showQuickPick(
      targets.map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false), uri })),
      { title: "CodeBridge: Choose target file", placeHolder: "Select the file this AI code block should replace" }
    );
    if (!selected) return { success: false, applied: 0, message: "Proposal cancelled; no files were changed." };
    normalizedPayload = { ...payload, files: [{ path: selected.label, content: payload.code }] };
  }
  const proposal = resolveProposalFiles(normalizedPayload);
  const snapshots: RollbackEntry[] = [];
  const changes: Array<{ uri: vscode.Uri; before: Uint8Array; after: Uint8Array; path: string }> = [];

  for (const file of proposal.files) {
    const uri = vscode.Uri.joinPath(workspace.uri, file.path);
    const absolute = uri.fsPath;
    const relative = path.relative(workspace.uri.fsPath, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Target escapes workspace: ${file.path}`);
    let before = new Uint8Array();
    let existed = true;
    try { before = await vscode.workspace.fs.readFile(uri); }
    catch { existed = false; }
    if (!existed && file.path.split("/").length > 1) {
      const parent = vscode.Uri.joinPath(uri, "..");
      try { await vscode.workspace.fs.stat(parent); } catch { throw new Error(`Parent directory does not exist for new file: ${file.path}`); }
    }
    const after = new TextEncoder().encode(file.content);
    const beforeText = new TextDecoder().decode(before);
    const afterDoc = await vscode.workspace.openTextDocument({ language: typeof payload.language === "string" ? payload.language : "plaintext", content: file.content });
    const beforeDoc = existed ? await vscode.workspace.openTextDocument(uri) : await vscode.workspace.openTextDocument({ language: afterDoc.languageId, content: "" });
    await vscode.commands.executeCommand("vscode.diff", beforeDoc.uri, afterDoc.uri, `CodeBridge Review: ${file.path}`, { preview: false });
    snapshots.push({ uri, existed, content: existed ? before : undefined });
    changes.push({ uri, before, after, path: file.path });
    // Capture a stable baseline for conflict detection, including empty/new files.
    void beforeText;
  }

  const choice = await vscode.window.showWarningMessage(
    `Apply ${changes.length} proposed file change(s)? Review the open diffs first.`,
    { modal: true, detail: "CodeBridge will verify that every target is unchanged before writing. A rollback snapshot will be kept in memory for this VS Code session." },
    "Apply all", "Reject"
  );
  if (choice !== "Apply all") return { success: false, applied: 0, message: "Proposal rejected; no files were changed." };

  for (const change of changes) {
    let current = new Uint8Array();
    let existsNow = true;
    try { current = await vscode.workspace.fs.readFile(change.uri); } catch { existsNow = false; }
    const snapshot = snapshots.find((entry) => entry.uri.toString() === change.uri.toString())!;
    if (existsNow !== snapshot.existed || (existsNow && sha256(current) !== sha256(snapshot.content!))) {
      throw new Error(`Conflict detected in ${change.path}. The file changed after the proposal was prepared; nothing was applied.`);
    }
  }

  const applied: RollbackEntry[] = [];
  try {
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index]!;
      await vscode.workspace.fs.writeFile(change.uri, change.after);
      applied.push(snapshots[index]!);
    }
  } catch (error) {
    for (const entry of applied.reverse()) {
      if (entry.existed) await vscode.workspace.fs.writeFile(entry.uri, entry.content!);
      else await vscode.workspace.fs.delete(entry.uri);
    }
    throw new Error(`Apply failed and completed writes were rolled back: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  latestRollback = snapshots;
  vscode.window.showInformationMessage(`CodeBridge applied ${changes.length} file change(s). Use “CodeBridge: Rollback Last Apply” to restore the previous contents.`);
  return { success: true, applied: changes.length, message: `Applied ${changes.length} file change(s).` };
}

const MAX_FILE_CHARS = 120_000;
const MAX_TREE_ENTRIES = 250;
const EXCLUDED_SEGMENTS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo",
  ".venv", "venv", "vendor", "__pycache__"
]);
const SENSITIVE_FILE = /(^|\/)(\.env(?:\..*)?|.*\.(pem|key|p12|pfx|crt|cer)|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.(json|ya?ml))$/i;

function isExcluded(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.split("/").some((part) => EXCLUDED_SEGMENTS.has(part))
    || SENSITIVE_FILE.test(normalized);
}

async function collectWorkspaceContext(options: { includeActiveFile: boolean; includeSelection: boolean }) {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const editor = vscode.window.activeTextEditor;
  const activePath = editor && workspace
    ? vscode.workspace.asRelativePath(editor.document.uri, false)
    : undefined;
  const selection = options.includeSelection && editor && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection).slice(0, 30_000)
    : undefined;

  let activeFile: { path: string; language: string; content: string; truncated: boolean } | undefined;
  if (options.includeActiveFile && editor && activePath && !isExcluded(activePath)) {
    const source = editor.document.getText();
    activeFile = {
      path: activePath,
      language: editor.document.languageId,
      content: source.slice(0, MAX_FILE_CHARS),
      truncated: source.length > MAX_FILE_CHARS
    };
  }

  let files: string[] = [];
  if (workspace) {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspace, "**/*"),
      "**/{.git,node_modules,dist,build,coverage,.next,.turbo,vendor,.venv,venv}/**",
      MAX_TREE_ENTRIES * 2
    );
    files = uris
      .map((uri) => vscode.workspace.asRelativePath(uri, false))
      .filter((path) => !isExcluded(path))
      .slice(0, MAX_TREE_ENTRIES)
      .sort((a, b) => a.localeCompare(b));
  }

  return {
    workspaceName: workspace?.name ?? "No workspace",
    rootName: workspace?.uri.fsPath.split(/[\\/]/).filter(Boolean).pop() ?? "",
    activeFile: activePath && !isExcluded(activePath) ? activePath : undefined,
    selection,
    activeFileContent: activeFile,
    files,
    generatedAt: new Date().toISOString(),
    limits: { maxFileChars: MAX_FILE_CHARS, maxTreeEntries: MAX_TREE_ENTRIES }
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  const savedAgentState = context.globalState.get<{ runs?: AgentRun[]; activeAgentRunId?: string }>(AGENT_STATE_KEY);
  for (const savedRun of savedAgentState?.runs ?? []) {
    if (!savedRun || typeof savedRun.id !== "string" || typeof savedRun.instruction !== "string") continue;
    const run = savedRun.status === "running" || savedRun.status === "waiting_approval"
      ? { ...savedRun, status: "stopped" as const, error: "Session interrupted by VS Code restart; resume is not supported in v0.8.0.", updatedAt: new Date().toISOString() }
      : savedRun;
    agentRuns.set(run.id, run);
  }
  activeAgentRunId = savedAgentState?.activeAgentRunId && agentRuns.has(savedAgentState.activeAgentRunId) ? savedAgentState.activeAgentRunId : undefined;
  agentAudit = context.globalState.get<AgentAuditEntry[]>(AGENT_AUDIT_KEY) ?? [];
  await persistAgentState();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "codebridge.showStatus";
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("codebridge.startPairing", async () => {
      await startBridge(context);
      pairingCode = (randomBytes(4).readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
      pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
      const output = vscode.window.createOutputChannel("CodeBridge AI");
      output.appendLine(`Pairing code: ${pairingCode}`);
      output.appendLine("This code expires in 60 seconds. Do not share it with anyone.");
      output.show(true);
      await vscode.env.clipboard.writeText(pairingCode);
      vscode.window.showInformationMessage("CodeBridge pairing code copied to clipboard. Enter it in the Chrome extension.");
    }),
    vscode.commands.registerCommand("codebridge.stopBridge", async () => {
      server?.close();
      server = undefined;
      pairingCode = undefined;
      setStatus(false);
      vscode.window.showInformationMessage("CodeBridge bridge stopped.");
    }),
    vscode.commands.registerCommand("codebridge.showStatus", () => {
      vscode.window.showInformationMessage(
        server ? `CodeBridge is listening on ${BRIDGE_HOST}:${vscode.workspace.getConfiguration("codebridge").get("port", BRIDGE_PORT)}`
          : "CodeBridge is offline. Run CodeBridge: Start Pairing."
      );
    }),
    vscode.commands.registerCommand("codebridge.analyzeProject", async () => {
      try {
        const index = await analyzeAndShow();
        vscode.window.showInformationMessage(`CodeBridge indexed ${index.files.length} source files and found ${index.relationships.length} local relationships.`);
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : "Project analysis failed.");
      }
    }),
    vscode.commands.registerCommand("codebridge.searchProject", async () => {
      const query = await vscode.window.showInputBox({ prompt: "Search symbols, files, imports, and source text", placeHolder: "e.g. authentication middleware" });
      if (!query?.trim()) return;
      try {
        const { internalFiles } = await buildProjectIndex();
        const matches = searchProjectIndex(internalFiles, query);
        const selected = await vscode.window.showQuickPick(matches.map((match) => ({
          label: match.path,
          description: `score ${match.score} · ${match.language}`,
          detail: match.symbols.slice(0, 5).map((symbol) => `${symbol.kind} ${symbol.name}`).join(", "),
          path: match.path
        })), { title: "CodeBridge Project Search", placeHolder: `${matches.length} matching files` });
        if (selected) {
          const workspace = vscode.workspace.workspaceFolders?.[0];
          if (workspace) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, selected.path));
            await vscode.window.showTextDocument(document, { preview: true });
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : "Project search failed.");
      }
    }),
    vscode.commands.registerCommand("codebridge.createWorkflow", async () => {
      const instruction = await vscode.window.showInputBox({
        title: "CodeBridge: Create AI Development Workflow",
        prompt: "Describe the development task",
        placeHolder: "e.g. Add JWT authentication with login endpoint and tests",
        ignoreFocusOut: true
      });
      if (!instruction?.trim()) return;
      try {
        const workflow = createWorkflowPlan(instruction);
        workflows.set(workflow.id, workflow);
        activeWorkflowId = workflow.id;
        const panel = vscode.window.createWebviewPanel("codebridgeWorkflow", "CodeBridge Workflow", vscode.ViewColumn.Beside, { enableScripts: false });
        const summary = workflowSummary(workflow);
        panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px var(--vscode-font-family);padding:20px;color:var(--vscode-foreground)}.muted{color:var(--vscode-descriptionForeground)}li{margin:14px 0}code{color:var(--vscode-textLink-foreground)}</style></head><body><h1>${escapeHtml(workflow.title)}</h1><p class="muted">Local workflow plan · ${summary.totalTasks} tasks · ${summary.progress}% complete</p><p>${escapeHtml(workflow.instruction)}</p><ol>${workflow.tasks.map(task => `<li><b>${escapeHtml(task.title)}</b><br><span class="muted">${escapeHtml(task.description)}</span></li>`).join("")}</ol><hr><p class="muted">${escapeHtml(workflow.notes[0] ?? "")}</p><p>Use <b>CodeBridge: Update Workflow Stage</b> to move through the approval lifecycle.</p></body></html>`;
        vscode.window.showInformationMessage(`Workflow created with ${workflow.tasks.length} tasks. No files were changed.`);
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not create workflow.");
      }
    }),
    vscode.commands.registerCommand("codebridge.updateWorkflowStage", async () => {
      const workflow = activeWorkflowId ? workflows.get(activeWorkflowId) : undefined;
      if (!workflow) { vscode.window.showInformationMessage("Create a workflow first."); return; }
      const stages: WorkflowStage[] = ["analyzing", "proposed", "reviewing", "applying", "completed", "rejected", "cancelled", "failed"];
      const selected = await vscode.window.showQuickPick(stages.filter((stage) => {
        try { transitionWorkflow(workflow, stage); return true; } catch { return false; }
      }), { title: `Update workflow: ${workflow.stage}`, placeHolder: "Select the next valid stage" });
      if (!selected) return;
      try {
        const updated = transitionWorkflow(workflow, selected);
        workflows.set(updated.id, updated);
        vscode.window.showInformationMessage(`Workflow stage updated: ${updated.stage}`);
      } catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : "Workflow update failed."); }
    }),
    vscode.commands.registerCommand("codebridge.updateWorkflowTask", async () => {
      const workflow = activeWorkflowId ? workflows.get(activeWorkflowId) : undefined;
      if (!workflow) { vscode.window.showInformationMessage("Create a workflow first."); return; }
      const task = await vscode.window.showQuickPick(workflow.tasks.map((item) => ({ label: item.title, description: item.status, id: item.id })), { title: "Select workflow task" });
      if (!task) return;
      const status = await vscode.window.showQuickPick(["pending", "in_progress", "completed", "blocked"] as const, { title: "Set task status" });
      if (!status) return;
      const updated = updateTask(workflow, task.id, status);
      workflows.set(updated.id, updated);
      vscode.window.showInformationMessage(`Task updated. Progress: ${workflowSummary(updated).progress}%`);
    }),
    vscode.commands.registerCommand("codebridge.startAgentRun", async () => {
      const instruction = await vscode.window.showInputBox({ title: "CodeBridge Agent Runtime", prompt: "Describe what the agent should inspect or help with", ignoreFocusOut: true });
      if (!instruction?.trim()) return;
      try { const run = createAgentRun(instruction); agentRuns.set(run.id, run); activeAgentRunId = run.id; await persistAgentState();
        const panel = vscode.window.createWebviewPanel("codebridgeAgent", "CodeBridge Agent", vscode.ViewColumn.Beside, { enableScripts: false });
        panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px var(--vscode-font-family);padding:20px;color:var(--vscode-foreground)}li{margin:10px 0}.muted{color:var(--vscode-descriptionForeground)}</style></head><body><h1>Agent run created</h1><p>${escapeHtml(run.instruction)}</p><p>Status: <b>${run.status}</b> · Max iterations: ${run.maxIterations}</p><h2>Available agent tools</h2><ul>${AGENT_TOOLS.map((tool) => `<li><b>${escapeHtml(tool.name)}</b> — ${escapeHtml(tool.description)}${tool.requiresApproval ? " (approval required)" : " (read-only)"}</li>`).join("")}</ul><p class="muted">File writes require a native VS Code approval dialog and diff review. Terminal, delete, network, and arbitrary code execution remain disabled.</p></body></html>`;
        vscode.window.showInformationMessage("Agent run created. Pair the browser to send approved read-only tool requests.");
      } catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not create agent run."); }
    }),
    vscode.commands.registerCommand("codebridge.stopAgentRun", async () => {
      const run = activeAgentRunId ? agentRuns.get(activeAgentRunId) : undefined; if (!run) { vscode.window.showInformationMessage("No active agent run."); return; }
      const stopped = finishAgentRun(run, "stopped"); agentRuns.set(stopped.id, stopped); auditAgent(stopped.id, "agent.stop", "Stopped from VS Code command", "stopped"); await persistAgentState(); vscode.window.showInformationMessage("CodeBridge agent run stopped.");
    }),
    vscode.commands.registerCommand("codebridge.showAgentHistory", async () => {
      const runs = [...agentRuns.values()].reverse();
      const items = runs.map((run) => ({ label: `${run.status} · ${run.instruction.slice(0, 70)}`, description: new Date(run.updatedAt).toLocaleString(), runId: run.id }));
      const selected = await vscode.window.showQuickPick(items, { title: "CodeBridge Agent Sessions", placeHolder: "Select a session to inspect its audit trail" });
      if (!selected) return;
      const entries = agentAudit.filter((entry) => entry.runId === selected.runId);
      const output = vscode.window.createOutputChannel("CodeBridge Agent Audit");
      output.clear(); output.appendLine(`Run: ${selected.runId}`); output.appendLine("");
      for (const entry of entries) output.appendLine(`${entry.at} | ${entry.outcome.toUpperCase()} | ${entry.action} | ${entry.detail}`);
      output.show(true);
    }),
    vscode.commands.registerCommand("codebridge.rollbackLastApply", async () => {
      if (!extensionContext) return;
      const manifestPath = path.join(extensionContext.globalStorageUri.fsPath, ROLLBACK_MANIFEST);
      try {
        const manifest = JSON.parse(await readNodeFile(manifestPath, "utf8")) as TransactionSnapshot;
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace || (await realpath(workspace.uri.fsPath)) !== manifest.workspaceRoot) throw new Error("Rollback belongs to a different workspace.");
        const prepared = manifest.files.map((item) => ({ ...item, uri: vscode.Uri.joinPath(workspace.uri, validateWorkspaceRelativePath(item.path)) }));
        const states = new Map<string, "already-restored" | "applied">();
        for (const item of prepared) {
          let current: Uint8Array | undefined;
          try { current = await vscode.workspace.fs.readFile(item.uri); } catch { current = undefined; }
          if (item.existed) {
            if (!current) throw new Error(`Rollback conflict: ${item.path} is missing. No files were restored.`);
            const hash = sha256(current);
            if (hash === item.beforeHash) states.set(item.path, "already-restored");
            else if (hash === item.afterHash) states.set(item.path, "applied");
            else throw new Error(`Rollback conflict: ${item.path} changed after the transaction. No files were restored.`);
          } else {
            if (!current) states.set(item.path, "already-restored");
            else if (sha256(current) === item.afterHash) states.set(item.path, "applied");
            else throw new Error(`Rollback conflict: ${item.path} changed after the transaction. No files were restored.`);
          }
        }
        const choice = await vscode.window.showWarningMessage(`Restore ${prepared.length} file(s) from the last transaction?`, { modal: true, detail: "Every current file will be hash-checked before restoration. Files already in their original state are skipped." }, "Restore transaction", "Cancel");
        if (choice !== "Restore transaction") return;
        for (const item of [...prepared].reverse()) {
          if (states.get(item.path) === "already-restored") continue;
          if (item.existed) await vscode.workspace.fs.writeFile(item.uri, Buffer.from(item.beforeBase64 ?? "", "base64"));
          else await vscode.workspace.fs.delete(item.uri);
        }
        await vscode.workspace.fs.delete(vscode.Uri.file(manifestPath));
        latestRollback = [];
        vscode.window.showInformationMessage("CodeBridge transaction rollback completed.");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          vscode.window.showErrorMessage(error instanceof Error ? error.message : "Persistent rollback failed.");
          return;
        }
      }
      if (!latestRollback.length) { vscode.window.showInformationMessage("No CodeBridge rollback snapshot is available."); return; }
      const choice = await vscode.window.showWarningMessage(`Restore ${latestRollback.length} file(s) to their pre-apply state?`, { modal: true }, "Restore", "Cancel");
      if (choice !== "Restore") return;
      for (const entry of [...latestRollback].reverse()) {
        if (entry.existed) await vscode.workspace.fs.writeFile(entry.uri, entry.content!);
        else { try { await vscode.workspace.fs.delete(entry.uri); } catch { /* already absent */ } }
      }
      latestRollback = [];
      vscode.window.showInformationMessage("CodeBridge rollback completed.");
    })
  );

  setStatus(false);
}

export function deactivate(): void {
  server?.close();
  server = undefined;
}

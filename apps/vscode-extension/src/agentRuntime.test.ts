import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, beginToolCall, createAgentRun, finishAgentRun, validateToolCall } from "./agentRuntime";

describe("agent runtime", () => {
  it("creates bounded runs", () => { const run = createAgentRun("Implement a safe feature", 99); expect(run.maxIterations).toBe(12); expect(run.status).toBe("running"); });
  it("rejects unknown tools", () => { expect(() => validateToolCall({ name: "terminal.exec", arguments: {} })).toThrow(/disabled/); });
  it("registers file writes as approval-gated tools", () => { const call = validateToolCall({ name: "workspace.write_file", arguments: { path: "src/example.ts", content: "export {};" } }); expect(call.name).toBe("workspace.write_file"); });
  it("exposes only fixed Git commands and multi-file transactions as approval-gated tools", () => {
    for (const name of ["workspace.apply_files", "workspace.git_status", "workspace.git_diff_check"] as const) {
      const tool = AGENT_TOOLS.find((item) => item.name === name);
      expect(tool).toBeDefined();
      expect(tool?.requiresApproval).toBe(true);
    }
  });
  it("rejects arbitrary shell execution", () => {
    expect(() => validateToolCall({ name: "terminal.exec", arguments: { command: "rm -rf /" } })).toThrow(/disabled/);
  });
  it("increments bounded tool iterations", () => { const run = createAgentRun("Inspect this project"); const call = validateToolCall({ name: "workspace.list_files", arguments: {} }); expect(beginToolCall(run, call).iteration).toBe(1); });
  it("does not allow calls after completion", () => { const run = finishAgentRun(createAgentRun("Inspect this project"), "completed"); const call = validateToolCall({ name: "workspace.list_files", arguments: {} }); expect(() => beginToolCall(run, call)).toThrow(/not active/); });
});

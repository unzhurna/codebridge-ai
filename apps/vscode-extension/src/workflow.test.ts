import { describe, expect, it } from "vitest";
import { createWorkflowPlan, transitionWorkflow, updateTask, workflowSummary } from "./workflow";

describe("workflow engine", () => {
  it("creates a local plan with tasks and no provider dependency", () => {
    const plan = createWorkflowPlan("Add a REST API endpoint with database migration and tests");
    expect(plan.stage).toBe("planned");
    expect(plan.tasks.length).toBeGreaterThan(6);
    expect(plan.notes[0]).toContain("No AI provider");
  });
  it("rejects invalid transitions", () => {
    const plan = createWorkflowPlan("Implement a secure login feature");
    expect(() => transitionWorkflow(plan, "completed")).toThrow("Invalid workflow transition");
  });
  it("tracks task progress", () => {
    const plan = createWorkflowPlan("Implement a secure login feature");
    const updated = updateTask(plan, plan.tasks[0]!.id, "completed");
    expect(workflowSummary(updated).completedTasks).toBe(1);
  });
});

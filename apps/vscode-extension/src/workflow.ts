import { randomUUID } from "node:crypto";

export type WorkflowStage = "planned" | "analyzing" | "proposed" | "reviewing" | "applying" | "completed" | "rejected" | "cancelled" | "failed";
export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface WorkflowTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependsOn: string[];
}

export interface WorkflowRecord {
  id: string;
  title: string;
  instruction: string;
  stage: WorkflowStage;
  tasks: WorkflowTask[];
  createdAt: string;
  updatedAt: string;
  notes: string[];
}

const transitions: Record<WorkflowStage, WorkflowStage[]> = {
  planned: ["analyzing", "cancelled"],
  analyzing: ["proposed", "failed", "cancelled"],
  proposed: ["reviewing", "rejected", "cancelled"],
  reviewing: ["applying", "rejected", "cancelled"],
  applying: ["completed", "failed"],
  completed: [], rejected: [], cancelled: [], failed: ["analyzing", "cancelled"]
};

/** Local, deterministic task decomposition. It does not call an AI provider. */
export function createWorkflowPlan(instruction: string): WorkflowRecord {
  const clean = instruction.trim().replace(/\s+/g, " ");
  if (clean.length < 8) throw new Error("Please provide a more specific development instruction (at least 8 characters).");
  if (clean.length > 8_000) throw new Error("Instruction exceeds the 8,000 character limit.");

  const lower = clean.toLowerCase();
  const tasks: Array<Omit<WorkflowTask, "id" | "status">> = [
    { title: "Inspect project rules and architecture", description: "Review workspace structure, project instructions, existing patterns, and relevant dependencies.", dependsOn: [] },
    { title: "Identify impacted files and symbols", description: "Use local project intelligence to identify implementation points and dependencies.", dependsOn: [] },
    { title: "Prepare implementation proposal", description: "Prepare a scoped, multi-file proposal. Do not modify workspace files during planning.", dependsOn: [] },
    { title: "Review proposed changes", description: "Inspect every diff, validate scope, and resolve conflicts before approval.", dependsOn: [] },
    { title: "Apply approved changes", description: "Apply only explicitly approved files and preserve rollback snapshots.", dependsOn: [] },
    { title: "Verify and summarize", description: "Review changed files and provide a summary. Tests or commands require separate user action.", dependsOn: [] }
  ];

  if (/test|spec|coverage/.test(lower)) tasks.splice(5, 0, {
    title: "Plan test coverage", description: "Identify existing test conventions and propose relevant test cases.", dependsOn: []
  });
  if (/api|endpoint|route|controller/.test(lower)) tasks.splice(2, 0, {
    title: "Check API contract and validation", description: "Review route conventions, request validation, response shape, and compatibility.", dependsOn: []
  });
  if (/database|schema|migration|sql|model/.test(lower)) tasks.splice(2, 0, {
    title: "Assess data model impact", description: "Inspect schema and migration conventions; identify compatibility and data safety concerns.", dependsOn: []
  });

  const ids = tasks.map(() => randomUUID());
  const now = new Date().toISOString();
  return {
    id: randomUUID(), title: clean.slice(0, 100), instruction: clean,
    stage: "planned",
    tasks: tasks.map((task, index) => ({ ...task, id: ids[index]!, status: "pending", dependsOn: index ? [ids[index - 1]!] : [] })),
    createdAt: now, updatedAt: now,
    notes: ["Plan generated locally using deterministic templates. No AI provider was called."]
  };
}

export function transitionWorkflow(workflow: WorkflowRecord, next: WorkflowStage): WorkflowRecord {
  if (!transitions[workflow.stage].includes(next)) {
    throw new Error(`Invalid workflow transition: ${workflow.stage} → ${next}.`);
  }
  return { ...workflow, stage: next, updatedAt: new Date().toISOString() };
}

export function updateTask(workflow: WorkflowRecord, taskId: string, status: TaskStatus): WorkflowRecord {
  const index = workflow.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw new Error("Workflow task not found.");
  const tasks = workflow.tasks.map((task, i) => i === index ? { ...task, status } : task);
  return { ...workflow, tasks, updatedAt: new Date().toISOString() };
}

export function workflowSummary(workflow: WorkflowRecord) {
  const completed = workflow.tasks.filter((task) => task.status === "completed").length;
  return { id: workflow.id, title: workflow.title, stage: workflow.stage, totalTasks: workflow.tasks.length, completedTasks: completed, progress: Math.round(completed / workflow.tasks.length * 100) };
}

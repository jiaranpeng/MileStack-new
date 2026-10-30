import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject, openProjectContext, type ProjectContext } from "../../src/project/project-context.js";

const contexts: ProjectContext[] = [];
const roots: string[] = [];
async function createContext() {
  const root = mkdtempSync(path.join(tmpdir(), "milestack-manual-")); roots.push(root);
  const initialized = await initializeProject(root); initialized.database.close();
  const context = await openProjectContext(root); contexts.push(context);
  return context;
}
afterEach(() => {
  for (const context of contexts.splice(0)) context.database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("custom manual-approval default", () => {
  it("accepts a working-tree submission without Git and archives only after human approval", async () => {
    const { service, project } = await createContext();
    const task = service.createTask({ projectId: project.id, title: "人工确认", createdBy: "developer", status: "ready", riskLevel: "low" });
    expect(task.task.integrationRequired).toBe(false);
    const run = service.startTask({ projectId: project.id, taskId: task.task.id });
    const submitted = service.submitForReview({ projectId: project.id, taskId: task.task.id, runId: run.runId, summary: "工作区交付，无需提交 Git" });
    expect(submitted.task.status).toBe("in_review");
    expect(submitted.reviews[0]?.commitSha).toBe("");
    const review = service.startReview({ projectId: project.id, taskId: task.task.id });
    const passed = service.completeReview({ projectId: project.id, taskId: task.task.id, reviewRunId: review.reviewRunId, decision: "passed", summary: "验证通过", verificationEvidence: [{ command: "check", result: "passed" }] });
    expect(passed.task.status).toBe("in_review");
    const approved = service.approveTask({ projectId: project.id, taskId: task.task.id });
    expect(approved.task.status).toBe("completed");
    expect(approved.reviews[0]?.integrationStatus).toBe("not_required");
  });
  it("permits the next dependency once its predecessor is submitted for review", async () => {
    const { service, project } = await createContext();
    const parent = service.createTask({ projectId: project.id, title: "前置", createdBy: "developer", status: "ready" });
    const child = service.createTask({ projectId: project.id, title: "后续", createdBy: "developer", status: "ready", dependencyIds: [parent.task.id] });
    const run = service.startTask({ projectId: project.id, taskId: parent.task.id });
    service.submitForReview({ projectId: project.id, taskId: parent.task.id, runId: run.runId, summary: "待人工审核" });
    const listed = service.listTasks({ projectId: project.id, status: "ready" });
    expect(listed.tasks.find((task) => task.id === child.task.id)?.runnable).toBe(true);
    expect(service.startTask({ projectId: project.id, taskId: child.task.id }).runId).toBeTruthy();
  });
  it("allows direct human acceptance without an AI review or Git integration", async () => {
    const { service, project } = await createContext();
    const task = service.createTask({ projectId: project.id, title: "直接验收", createdBy: "developer", status: "ready" });
    const run = service.startTask({ projectId: project.id, taskId: task.task.id });
    service.submitForReview({ projectId: project.id, taskId: task.task.id, runId: run.runId, summary: "已交付" });
    const accepted = service.waiveTaskApproval({ projectId: project.id, taskId: task.task.id, reason: "已人工检查" });
    expect(accepted.task.status).toBe("completed");
    expect(accepted.reviews[0]?.status).toBe("waived");
  });
});

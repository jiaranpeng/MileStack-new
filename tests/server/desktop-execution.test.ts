import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHttpServer } from "../../src/server/server.js";
import type { DesktopMessenger, DesktopThread } from "../../src/server/codex-desktop-client.js";

describe("desktop execution from ready task details", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof createHttpServer>>;
  let thread: DesktopThread;
  let sent: Array<{ threadId: string; prompt: string }>;
  let sendFailure: boolean;
  let messenger: DesktopMessenger;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "milestack-desktop-"));
    mkdirSync(path.join(root, "ui"));
    writeFileSync(path.join(root, "ui/index.html"), "<h1>test</h1>");
    thread = { id: randomUUID(), title: "项目实施聊天", cwd: root, hostId: "local", status: "idle" };
    sent = [];
    sendFailure = false;
    messenger = {
      listThreads: async () => [thread, { ...thread, id: randomUUID(), cwd: path.join(root, "another-project") }],
      send: async (threadId, prompt) => { sent.push({ threadId, prompt }); if (sendFailure) throw new Error("delivery timeout"); },
      close: async () => {},
    };
    server = await createHttpServer({ projectRoot: root, staticDir: path.join(root, "ui"), desktopMessenger: messenger });
  });
  afterEach(async () => { await server.app.close(); server.context.database.close(); rmSync(root, { recursive: true, force: true }); });
  const execute = (server: Awaited<ReturnType<typeof createHttpServer>>, taskId: string, threadId: string, headers = {}) =>
    server.app.inject({ method: "POST", url: `/api/tasks/${taskId}/execute`, payload: { threadId }, headers });
  function createReady() {
    return server.context.service.createTask({ projectId: server.context.project.id, title: "点击执行", createdBy: "developer", status: "ready" });
  }

  it("supports both inbox-confirm-ready and directly-created ready tasks while preserving conversation claiming", async () => {
    const created = await server.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "草稿路线", status: "inbox" } });
    const taskId = created.json().task.id as string;
    expect((await execute(server, taskId, thread.id)).statusCode).toBe(409);
    const confirmed = await server.app.inject({ method: "POST", url: `/api/tasks/${taskId}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    const response = await execute(server, taskId, thread.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().dispatch).toMatchObject({ status: "sent", threadId: thread.id, taskId });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.prompt).toContain(taskId);
    expect(sent[0]?.prompt).toContain(root);
    expect(sent[0]?.prompt).toContain("get_task");
    expect(sent[0]?.prompt).toContain("start_task");
    expect(server.context.service.getTask({ projectId: server.context.project.id, taskId }).task.status).toBe("ready");
    const started = server.context.service.startTask({ projectId: server.context.project.id, taskId });
    expect(started.runId).toBeTruthy();
    expect(started.task.task.status).toBe("running");
    expect((await execute(server, taskId, thread.id)).statusCode).toBe(409);
  });

  it("sends directly-created ready tasks only once, including concurrent clicks and service restarts", async () => {
    const task = createReady().task;
    const responses = await Promise.all([execute(server, task.id, thread.id), execute(server, task.id, thread.id)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(sent).toHaveLength(1);
    await server.app.close(); server.context.database.close();
    server = await createHttpServer({ projectRoot: root, staticDir: path.join(root, "ui"), desktopMessenger: messenger });
    expect((await execute(server, task.id, thread.id)).statusCode).toBe(409);
    expect(sent).toHaveLength(1);
    const state = await server.app.inject({ method: "GET", url: `/api/tasks/${task.id}/execution` });
    expect(state.json()).toMatchObject({ taskStatus: "ready", canExecute: false, dispatch: { status: "sent" } });
  });

  it("keeps uncertain deliveries locked and never retries automatically", async () => {
    const task = createReady().task;
    sendFailure = true;
    const response = await execute(server, task.id, thread.id);
    expect(response.json().dispatch.status).toBe("unknown");
    expect((await execute(server, task.id, thread.id)).statusCode).toBe(409);
    expect(sent).toHaveLength(1);
    expect(server.context.service.getTask({ projectId: server.context.project.id, taskId: task.id }).task.status).toBe("ready");
  });

  it("rejects wrong projects, active chats, cross-site requests and unfulfilled dependencies without sending", async () => {
    const task = createReady().task;
    expect((await execute(server, task.id, randomUUID())).statusCode).toBe(400);
    thread.status = "active";
    expect((await execute(server, task.id, thread.id)).statusCode).toBe(409);
    thread.status = "idle";
    expect((await execute(server, task.id, thread.id, { origin: "https://untrusted.example" })).statusCode).toBe(403);
    expect((await execute(server, task.id, thread.id, { host: "untrusted.example" })).statusCode).toBe(403);
    const dependent = server.context.service.createTask({ projectId: server.context.project.id, title: "等待依赖", createdBy: "developer", status: "ready", dependencyIds: [task.id] });
    expect((await execute(server, dependent.task.id, thread.id)).statusCode).toBe(409);
    expect(sent).toHaveLength(0);
    const listed = await server.app.inject({ method: "GET", url: "/api/codex/threads" });
    expect(listed.json().threads.map((entry: DesktopThread) => entry.id)).toEqual([thread.id]);
  });

  it("permits a genuine rerun after the previous run is released", async () => {
    const task = createReady().task;
    expect((await execute(server, task.id, thread.id)).statusCode).toBe(200);
    const started = server.context.service.startTask({ projectId: server.context.project.id, taskId: task.id });
    server.context.service.releaseTask({ projectId: server.context.project.id, taskId: task.id, runId: started.runId, reason: "用户释放，稍后重试" });
    expect((await execute(server, task.id, thread.id)).statusCode).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("does not dispatch another task in the same checkout while one is pending or running", async () => {
    const first = createReady().task;
    const second = createReady().task;
    expect((await execute(server, first.id, thread.id)).statusCode).toBe(200);
    expect((await execute(server, second.id, thread.id)).statusCode).toBe(409);
    server.context.service.startTask({ projectId: server.context.project.id, taskId: first.id });
    expect((await execute(server, second.id, thread.id)).statusCode).toBe(409);
    expect(sent).toHaveLength(1);
  });
});

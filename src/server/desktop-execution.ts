import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectContext } from "../project/project-context.js";
import type { TaskDetails } from "../core/query-contract.js";
import { CodexDesktopClient, type DesktopMessenger } from "./codex-desktop-client.js";

const executeInputSchema = z.object({ threadId: z.string().uuid() }).strict();
const dispatchSchema = z.object({
  id: z.string().uuid(), taskId: z.string(), attempt: z.string(), threadId: z.string().uuid(), threadTitle: z.string(),
  status: z.enum(["sending", "sent", "unknown"]), createdAt: z.string(), message: z.string().optional(),
});
type Dispatch = z.infer<typeof dispatchSchema>;
class DispatchError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export function guardLocalRequest(request: FastifyRequest, action = "执行任务"): void {
  const host = request.headers.host ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) ||
      !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) || request.headers["sec-fetch-site"] === "cross-site") {
    throw new DispatchError(403, `${action}仅允许从本机 MileStack 页面操作。`);
  }
  if (request.headers.origin && request.headers.origin !== new URL(`http://${host}`).origin) {
    throw new DispatchError(403, "执行请求来源与 MileStack 页面不一致。");
  }
}

function normalizeRoot(root: string): string {
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); } catch { /* Compare normalized paths when a directory is unavailable. */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function attemptFor(details: TaskDetails): string {
  // Policy edits do not create another execution attempt. A claim, release,
  // reconfirmation or reopen does, so resubmission after a genuine new run works.
  return details.events.filter((event) => ["created", "confirmed", "started", "released", "reopened", "changes_requested"].includes(event.type)).at(-1)?.id ?? details.task.id;
}

export function registerDesktopExecutionRoutes(app: FastifyInstance, context: ProjectContext, messenger: DesktopMessenger = new CodexDesktopClient(context.projectRoot)): void {
  const dispatchRoot = path.join(context.projectRoot, ".milestack", "desktop-dispatches");
  const activePath = path.join(dispatchRoot, "active.json");
  const detailsFor = (taskId: string) => context.service.getTask({ projectId: context.project.id, taskId, view: "full" });
  const recordPath = (details: TaskDetails) => path.join(dispatchRoot, createHash("sha256").update(`${details.task.id}\0${attemptFor(details)}`).digest("hex") + ".json");
  const readRecord = (filename: string): Dispatch | null => existsSync(filename) ? dispatchSchema.parse(JSON.parse(readFileSync(filename, "utf8"))) : null;
  const projectThreads = async () => (await messenger.listThreads()).filter((thread) => thread.hostId === "local" && normalizeRoot(thread.cwd) === normalizeRoot(context.projectRoot));

  const executableReason = (details: TaskDetails): string | null => {
    if (details.task.status !== "ready") return "仅就绪任务可以执行。";
    if (!details.task.riskConfirmed) return "请先确认该任务的风险等级。";
    let cursor: string | undefined;
    let runnable = false;
    do {
      const page = context.service.listTasks({ projectId: context.project.id, status: "ready", limit: 100, ...(cursor ? { cursor } : {}) });
      const summary = page.tasks.find((task) => task.id === details.task.id);
      if (summary) { runnable = summary.runnable; break; }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!runnable) return "该任务还有未满足的前置依赖。";
    if (context.repository.listByProjectId(context.project.id).some((task) => task.activeRunId && ["running", "blocked"].includes(task.status))) {
      return "当前项目已有领取中的任务，请等它结束或释放后再执行。";
    }
    return null;
  };

  const route = <T>(handler: (request: FastifyRequest) => Promise<T> | T) => async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
    try { guardLocalRequest(request); return await handler(request); }
    catch (error) {
      const code = error instanceof DispatchError ? error.statusCode : error instanceof z.ZodError ? 400 :
        error && typeof error === "object" && "code" in error && error.code === "TASK_NOT_FOUND" ? 404 : 503;
      return reply.code(code).send({ error: error instanceof z.ZodError ? "执行请求格式无效。" : error instanceof Error ? error.message : "连接 Codex 桌面版失败。" });
    }
  };

  app.get("/api/codex/threads", route(async () => ({ threads: await projectThreads() })));
  app.get("/api/tasks/:id/execution", route((request) => {
    const details = detailsFor(z.object({ id: z.string().min(1) }).parse(request.params).id);
    const dispatch = readRecord(recordPath(details));
    const reason = executableReason(details);
    return { taskStatus: details.task.status, canExecute: reason === null && dispatch === null, reason, dispatch };
  }));

  app.post("/api/tasks/:id/execute", route(async (request) => {
    const taskId = z.object({ id: z.string().min(1) }).parse(request.params).id;
    const { threadId } = executeInputSchema.parse(request.body);
    const initial = detailsFor(taskId);
    const reason = executableReason(initial);
    if (reason) throw new DispatchError(409, reason);
    if (readRecord(recordPath(initial))) throw new DispatchError(409, "该任务已经发送过执行指令，请查看 Codex 会话，避免重复执行。");
    const threads = await projectThreads();
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new DispatchError(400, "请选择当前项目的 Codex 桌面会话。");
    if (!["idle", "notLoaded"].includes(thread.status)) throw new DispatchError(409, "所选 Codex 会话正在工作或等待处理，请选择空闲会话。");
    // Recheck after desktop I/O. The actual agent still atomically calls
    // start_task, exactly as in the original conversation workflow.
    const details = detailsFor(taskId);
    const currentReason = executableReason(details);
    if (currentReason) throw new DispatchError(409, currentReason);
    mkdirSync(dispatchRoot, { recursive: true });
    const priorActive = readRecord(activePath);
    if (priorActive) {
      let priorDetails: TaskDetails | undefined;
      try { priorDetails = detailsFor(priorActive.taskId); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "TASK_NOT_FOUND")) throw error; }
      if (priorDetails?.task.status === "ready" && attemptFor(priorDetails) === priorActive.attempt) {
        throw new DispatchError(409, "本项目已有执行指令等待 Codex 领取，请先查看对应会话。");
      }
      // Never expire an uncertain delivery by time: that could duplicate work.
      unlinkSync(activePath);
    }
    const dispatch: Dispatch = { id: randomUUID(), taskId, attempt: attemptFor(details), threadId, threadTitle: thread.title, status: "sending", createdAt: new Date().toISOString() };
    try { writeFileSync(activePath, JSON.stringify(dispatch), { flag: "wx" }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new DispatchError(409, "本项目已有任务正在发送，请勿重复点击。");
      throw error;
    }
    const filename = recordPath(details);
    try { writeFileSync(filename, JSON.stringify(dispatch), { flag: "wx" }); }
    catch (error) { unlinkSync(activePath); throw new DispatchError(409, "该任务已有派发记录，请先查看 Codex 会话。"); }
    const prompt = [
      "开发者在本机 MileStack 页面点击了【执行任务】，请立即执行下面指定的任务，无需再等待开发者在聊天中重复下达领取指令。",
      `项目目录：${context.projectRoot}`, `MileStack Task ID：${taskId}`, `任务标题：${details.task.title}`,
      "先核对当前会话的工作目录与上述项目目录一致，读取项目 AGENTS.md 和 .milestack/agent-instructions.md，然后调用当前项目 MileStack MCP 的 get_task（指定上述 taskId）。",
      "确认仍可执行后调用 start_task 原子领取，保存返回的 runId，按任务目标、大白话描述、验收标准及项目规则实施并验证，记录进展并按现有流程提交审核。",
      "若任务包含 images，请先调用 get_task_image 查看每张相关图片，再实施任务；不要忽略图片需求。",
      "若 MCP 未连接、项目不符、领取失败或权限不足，明确报告阻塞，不改用别的任务、不伪造领取状态、不修改任务数据库。",
      "本次只执行指定任务；保留用户已有改动，不自动推送、部署、合并或操作真实业务设备，不自审或自行批准。",
    ].join("\n");
    try {
      await messenger.send(threadId, prompt);
      dispatch.status = "sent";
    } catch (error) {
      dispatch.status = "unknown";
      dispatch.message = "未确认桌面版是否已收到指令。请查看所选聊天；为避免重复执行，系统不会自动重发。";
    }
    writeFileSync(filename, JSON.stringify(dispatch));
    writeFileSync(activePath, JSON.stringify(dispatch));
    return { dispatch };
  }));
  app.addHook("onClose", async () => { await messenger.close(); });
}

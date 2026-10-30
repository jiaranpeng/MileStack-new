import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpServer } from "../../src/server/server.js";
import { createMcpServer } from "../../src/mcp/server.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aH3sAAAAASUVORK5CYII=";
function resultJson(result: unknown): any {
  const typed = result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  expect(typed.isError).not.toBe(true);
  return JSON.parse(typed.content.find((item) => item.type === "text")?.text ?? "null");
}
describe("task image exchange", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof createHttpServer>>;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "milestack-images-"));
    mkdirSync(path.join(root, "ui")); writeFileSync(path.join(root, "ui/index.html"), "test");
    server = await createHttpServer({ projectRoot: root, staticDir: path.join(root, "ui") });
  });
  afterEach(async () => { await server.app.close(); server.context.database.close(); rmSync(root, { recursive: true, force: true }); });
  async function upload() {
    const response = await server.app.inject({ method: "POST", url: "/api/images", payload: { name: "参考图.png", dataBase64: png } });
    expect(response.statusCode).toBe(201); return response.json().image;
  }

  it("uploads, links, previews and persists images, preserving omitted attachments on edit", async () => {
    const image = await upload();
    const created = await server.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "图片任务", status: "inbox", imageIds: [image.id] } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    expect(created.json().task.images).toEqual([image]);
    const bytes = await server.app.inject({ method: "GET", url: `/api/images/${image.id}` });
    expect(bytes.headers["content-type"]).toBe("image/png");
    expect(bytes.rawPayload.toString("base64")).toBe(png);
    const edited = await server.app.inject({ method: "PUT", url: `/api/tasks/${taskId}`, payload: { title: "只改文字" } });
    expect(edited.json().task.images).toEqual([image]);
    await server.app.close(); server.context.database.close();
    server = await createHttpServer({ projectRoot: root, staticDir: path.join(root, "ui") });
    const reopened = await server.app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    expect(reopened.json().task.images).toEqual([image]);
    const removed = await server.app.inject({ method: "PUT", url: `/api/tasks/${taskId}/images`, payload: { imageIds: [] } });
    expect(removed.json().task.images).toEqual([]);
    expect(removed.json().task.status).toBe("inbox");
    expect(removed.json().events.at(-1).summary).toBe("Task images updated by developer.");
  });

  it("accepts images on an already claimed task without changing its run ownership", async () => {
    const image = await upload();
    const task = server.context.service.createTask({ projectId: server.context.project.id, title: "运行中补图", createdBy: "developer", status: "ready" });
    const started = server.context.service.startTask({ projectId: server.context.project.id, taskId: task.task.id });
    const attached = await server.app.inject({ method: "PUT", url: `/api/tasks/${task.task.id}/images`, payload: { imageIds: [image.id] } });
    expect(attached.json().task).toMatchObject({ status: "running", activeRunId: started.runId, images: [image] });
  });

  it("rejects non-images, invalid references, cross-origin uploads and unknown image paths", async () => {
    const fake = await server.app.inject({ method: "POST", url: "/api/images", payload: { name: "fake.png", dataBase64: Buffer.from("not an image").toString("base64") } });
    expect(fake.statusCode).toBe(400);
    const svg = await server.app.inject({ method: "POST", url: "/api/images", payload: { name: "active.svg", dataBase64: Buffer.from("<svg/>").toString("base64") } });
    expect(svg.statusCode).toBe(400);
    const denied = await server.app.inject({ method: "POST", url: "/api/images", headers: { origin: "https://other.example" }, payload: { name: "x.png", dataBase64: png } });
    expect(denied.statusCode).toBe(403);
    expect((await server.app.inject({ method: "GET", url: `/api/images/${randomUUID()}` })).statusCode).toBe(404);
    const forged = await server.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "错误引用", imageIds: [randomUUID()] } });
    expect(forged.statusCode).toBe(400);
    expect((await server.app.inject({ method: "GET", url: "/api/images/not-a-uuid" })).statusCode).toBe(404);
  });

  it("imports Codex plan paths, survives source removal, and returns actual image content through MCP", async () => {
    const sourcePath = path.join(root, "plan-image.png"); writeFileSync(sourcePath, Buffer.from(png, "base64"));
    const mcp = createMcpServer(server.context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "image-test", version: "1" });
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    try {
      const task = resultJson(await client.callTool({ name: "create_task", arguments: { title: "带图计划", imagePaths: [sourcePath] } }));
      rmSync(sourcePath);
      const details = resultJson(await client.callTool({ name: "get_task", arguments: { taskId: task.task.id } }));
      expect(details.task.images).toHaveLength(1);
      const image = details.task.images[0];
      const content = await client.callTool({ name: "get_task_image", arguments: { taskId: task.task.id, imageId: image.id } });
      expect(content.isError).not.toBe(true);
      expect(content.content).toContainEqual({ type: "image", mimeType: "image/png", data: png });
      const served = await server.app.inject({ method: "GET", url: `/api/images/${image.id}` });
      expect(served.rawPayload.toString("base64")).toBe(png);
      const imported = resultJson(await client.callTool({ name: "import_task_image", arguments: { dataBase64: png, name: "粘贴参考图.png" } }));
      const batch = resultJson(await client.callTool({ name: "create_tasks", arguments: { tasks: [{ title: "复用图片", imageIds: [imported.id] }, { title: "纯文字" }] } }));
      expect(batch[0].task.images[0].id).toBe(imported.id);
      expect(batch[1].task.images).toEqual([]);
      const unrelated = await client.callTool({ name: "get_task_image", arguments: { taskId: batch[1].task.id, imageId: imported.id } });
      expect(unrelated.isError).toBe(true);
    } finally { await client.close(); await mcp.close(); }
  });
});

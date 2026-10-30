// Process-level smoke test for the user's locally customized global bundle.
// Usage: node tests/mcp/installed-customization-smoke.mjs BUNDLE_PATH
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bundle = path.resolve(process.argv[2] ?? "dist/index.js");
const project = mkdtempSync(path.join(tmpdir(), "milestack-custom-smoke-"));
const client = new Client({ name: "milestack-local-smoke", version: "1.0.0" });
function json(result) {
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
try {
  execFileSync(process.execPath, [bundle, "init", "--project", project], { stdio: "pipe" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, "mcp", "--project", project], stderr: "pipe" }));
  const tools = await client.listTools();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aH3sAAAAASUVORK5CYII=";
  const imagePath = path.join(project, "plan-image.png");
  writeFileSync(imagePath, Buffer.from(png, "base64"));
  const illustrated = json(await client.callTool({ name: "create_task", arguments: { title: "带图计划", imagePaths: [imagePath] } }));
  rmSync(imagePath);
  assert.equal(illustrated.task.images.length, 1);
  const picture = await client.callTool({ name: "get_task_image", arguments: { taskId: illustrated.task.id, imageId: illustrated.task.images[0].id } });
  assert.ok(!picture.isError);
  assert.ok(picture.content.some((item) => item.type === "image" && item.data === png && item.mimeType === "image/png"));
  const submitTool = tools.tools.find((tool) => tool.name === "submit_for_review");
  assert.ok(!submitTool.inputSchema.required.includes("commitSha"), "Preserve optional Git commit policy");
  const description = "核心功能：温度配置刷新\n\n保存后只提示，点击独立按钮才刷新。\n- POST /materialDepotEnvironment/temperature/configuration/refresh\n- 不传工区或设备列表";
  const created = json(await client.callTool({ name: "create_task", arguments: { title: "业务说明测试", plainLanguageDescription: description } }));
  assert.equal(created.task.plainLanguageDescription, description);
  const details = json(await client.callTool({ name: "get_task", arguments: { taskId: created.task.id, view: "full" } }));
  assert.equal(details.task.plainLanguageDescription, description);
  const batch = json(await client.callTool({ name: "create_tasks", arguments: { tasks: [{ title: "带说明", plainLanguageDescription: description }, { title: "旧格式兼容" }] } }));
  assert.equal(batch[0].task.plainLanguageDescription, description);
  assert.equal(batch[1].task.plainLanguageDescription, null);
  // Seed developer confirmation in this disposable test database.
  const db = new BetterSqlite3(path.join(project, ".milestack", "milestack.db"));
  db.prepare("UPDATE tasks SET status = 'ready', risk_confirmed = 1, queue_position = 0 WHERE id = ?").run(created.task.id);
  db.close();
  const started = json(await client.callTool({ name: "start_task", arguments: { taskId: created.task.id } }));
  const submitted = json(await client.callTool({ name: "submit_for_review", arguments: { taskId: created.task.id, runId: started.runId, summary: "已完成业务说明测试", criteriaResults: [] } }));
  assert.equal(submitted.task.status, "in_review");
  assert.equal(submitted.reviews.at(-1).commitSha, "");
  assert.equal(submitted.task.plainLanguageDescription, description);
  console.log("PASS: installed MCP image import/plan path/read, create/batch/persistence, optional Git commit and manual-review workflow.");
} finally {
  await client.close();
  rmSync(project, { recursive: true, force: true });
}

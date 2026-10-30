// Verify two new global CLI processes while an existing service stays on 7331.
// Usage: node tests/server/installed-port-smoke.mjs GLOBAL_BUNDLE_PATH
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const bundle = path.resolve(process.argv[2] ?? "dist/index.js");
const original = await (await fetch("http://127.0.0.1:7331/api/project")).json();
const root = mkdtempSync(path.join(tmpdir(), "milestack-port-smoke-"));
const children = [];
async function start(project) {
  mkdirSync(project);
  const child = spawn(process.execPath, [bundle, "serve", "--project", project], {
    cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = ""; let stderr = "";
    const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${stderr}`)), 20000);
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-2000); });
    child.stdout.on("data", (data) => {
      output += data;
      const matched = output.match(/HTTP service running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (matched) { clearTimeout(timer); resolve(matched[1]); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${stderr}`)); });
  });
}
try {
  const firstProject = path.join(root, "project-one");
  const secondProject = path.join(root, "project-two");
  const firstUrl = await start(firstProject);
  const secondUrl = await start(secondProject);
  assert.ok(Number(new URL(firstUrl).port) > 7331);
  assert.ok(Number(new URL(secondUrl).port) > Number(new URL(firstUrl).port));
  const first = await (await fetch(`${firstUrl}/api/project`)).json();
  const second = await (await fetch(`${secondUrl}/api/project`)).json();
  assert.equal(first.rootPath, firstProject);
  assert.equal(second.rootPath, secondProject);
  assert.notEqual(first.id, second.id);
  const unchanged = await (await fetch("http://127.0.0.1:7331/api/project")).json();
  assert.equal(unchanged.id, original.id);
  assert.equal(unchanged.rootPath, original.rootPath);
  console.log(JSON.stringify({ existing: "http://127.0.0.1:7331", second: firstUrl, third: secondUrl, projectIsolation: true, existingServiceUnchanged: true }));
} finally {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill(); await exited;
  }));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  rmSync(root, { recursive: true, force: true });
}

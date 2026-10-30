import Fastify from "fastify";
import { createServer, type Server } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnAvailablePort } from "../../src/server/available-port.js";
import { startHttpServer } from "../../src/server/server.js";

async function bind(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, resolve);
  });
  return server;
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
afterEach(() => { vi.restoreAllMocks(); });

describe("automatic HTTP port selection", () => {
  it("skips two occupied consecutive ports and serves the correct project at the printed URL", async () => {
    let blockers: Server[] = [];
    let firstPort = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      const first = await bind(0);
      const address = first.address();
      if (!address || typeof address === "string" || address.port > 65533) { await close(first); continue; }
      firstPort = address.port;
      blockers = [first];
      try {
        blockers.push(await bind(firstPort + 1));
        const available = await bind(firstPort + 2);
        await close(available);
        break;
      } catch { await Promise.all(blockers.map(close)); blockers = []; }
    }
    expect(blockers).toHaveLength(2);
    const root = mkdtempSync(path.join(tmpdir(), "milestack-port-"));
    mkdirSync(path.join(root, "ui")); writeFileSync(path.join(root, "ui/index.html"), "port test");
    let running: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      running = await startHttpServer({ projectRoot: root, staticDir: path.join(root, "ui"), port: firstPort });
      expect(running.url).toBe(`http://127.0.0.1:${firstPort + 2}`);
      const response = await fetch(`${running.url}/api/project`);
      expect(response.status).toBe(200);
      expect((await response.json() as { rootPath: string }).rootPath).toBe(root);
    } finally {
      await running?.app.close(); running?.context.database.close();
      await Promise.all(blockers.map(close));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the real OS-assigned URL when the initial port is zero", async () => {
    const app = Fastify();
    try {
      const url = await listenOnAvailablePort(app, 0, "127.0.0.1");
      const address = app.server.address();
      expect(address && typeof address !== "string" ? address.port : 0).toBeGreaterThan(0);
      expect(url).toBe(`http://127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`);
    } finally { await app.close(); }
  });

  it("does not retry permission failures or overflow the valid port range", async () => {
    const app = Fastify();
    try {
      const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const listen = vi.spyOn(app, "listen").mockRejectedValueOnce(denied);
      await expect(listenOnAvailablePort(app, 7331, "127.0.0.1")).rejects.toBe(denied);
      expect(listen).toHaveBeenCalledTimes(1);
      listen.mockClear();
      const occupied = Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
      listen.mockRejectedValueOnce(occupied);
      await expect(listenOnAvailablePort(app, 65535, "127.0.0.1")).rejects.toBe(occupied);
      expect(listen).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});

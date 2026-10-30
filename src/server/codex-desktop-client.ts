import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export type DesktopThread = { id: string; title: string; status: string; cwd: string; hostId: string };
export interface DesktopMessenger {
  listThreads(): Promise<DesktopThread[]>;
  send(threadId: string, prompt: string): Promise<void>;
  close(): Promise<void>;
}

const connectionSchema = z.object({
  callerThreadId: z.string().uuid(),
  pipePath: z.string().regex(/^\\\\\.\\pipe\\codex-app-tools-[\da-f-]+$/i),
});
const threadPageSchema = z.object({
  threads: z.array(z.object({
    id: z.string(), title: z.string(), status: z.string(),
    cwd: z.string().nullable().optional(), hostId: z.string().optional(), kind: z.string().optional(),
  })),
  nextCursor: z.string().nullable().optional(),
});
const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** Uses the installed first-party desktop MCP adapter, preserving the actual
 * executor's caller context. No raw IPC protocol or fabricated caller is used. */
export class CodexDesktopClient implements DesktopMessenger {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private callerThreadId = "";

  constructor(private readonly projectRoot: string) {}

  private connection() {
    const filename = path.join(this.projectRoot, ".milestack", "desktop-connection.json");
    const inherited = connectionSchema.safeParse({ callerThreadId: process.env.CODEX_THREAD_ID, pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH });
    let connection = inherited.success ? inherited.data : connectionSchema.parse(
      existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) : {},
    );
    // Windows gives each desktop launch a new pipe. Reuse the real paired caller,
    // and reconnect only when there is one unambiguous running desktop instance.
    if (process.platform === "win32") {
      try {
        const pipes = readdirSync("\\\\.\\pipe\\").filter((name) => /^codex-app-tools-[\da-f-]+$/i.test(name));
        if (!pipes.includes(connection.pipePath.split("\\").at(-1) ?? "") && pipes.length === 1) {
          connection = { ...connection, pipePath: `\\\\.\\pipe\\${pipes[0]}` };
        }
      } catch { /* Keep the paired pipe; its connection error is surfaced. */ }
    }
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, JSON.stringify(connection, null, 2));
    return connection;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let connection: z.infer<typeof connectionSchema>;
      try { connection = this.connection(); }
      catch { throw new Error("尚未连接 Codex 桌面版。请保持桌面版打开，并从 Codex 会话启动 MileStack 网页服务完成本地连接。"); }
      const pluginRoot = path.join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "codex-app-tools");
      const pluginVersion = readdirSync(pluginRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .find((version) => existsSync(path.join(pluginRoot, version, "server.mjs")));
      if (!pluginVersion) throw new Error("未找到 Codex 桌面版的本地工具，请打开或更新桌面版后重试。");
      const client = new Client({ name: "milestack-desktop", version: "0.2.1" });
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, pluginVersion, "server.mjs")],
        env: { ...getDefaultEnvironment(), CODEX_APP_TOOLS_PIPE_PATH: connection.pipePath }, stderr: "pipe" });
      transport.stderr?.on("data", () => {});
      client.onclose = () => { if (this.client === client) this.client = undefined; };
      try {
        await client.connect(transport, { timeout: 10_000 });
        await client.listTools(undefined, { timeout: 10_000 });
      } catch (error) { await client.close(); throw error; }
      this.callerThreadId = connection.callerThreadId;
      this.client = client;
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connect();
    const result = toolResultSchema.parse(await client.callTool({ name, arguments: args, _meta: { codex_thread_id: this.callerThreadId } }, undefined, { timeout: 15_000 }));
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    if (result.isError) throw new Error(text || "Codex 桌面版拒绝了请求。");
    return text;
  }

  async listThreads(): Promise<DesktopThread[]> {
    const threads: DesktopThread[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.call("list_threads", { mode: "history", source: "codex", hostId: "local", limit: 50, ...(cursor ? { cursor } : {}) });
      const page = threadPageSchema.parse(JSON.parse(String(response)));
      for (const thread of page.threads) {
        if (thread.kind === "codex" && thread.cwd && (thread.hostId ?? "local") === "local") {
          threads.push({ id: thread.id, title: thread.title, status: thread.status, cwd: thread.cwd, hostId: "local" });
        }
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error("Codex 会话列表分页异常，请刷新后重试。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return threads;
  }

  async send(threadId: string, prompt: string): Promise<void> {
    await this.call("send_message_to_thread", { threadId, hostId: "local", prompt });
  }

  async close(): Promise<void> { const client = this.client; this.client = undefined; await client?.close(); }
}

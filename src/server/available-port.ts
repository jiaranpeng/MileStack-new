import type { FastifyInstance } from "fastify";

/** Bind the actual HTTP server, avoiding a separate probe and its port race. */
export async function listenOnAvailablePort(app: FastifyInstance, startPort: number, host: string): Promise<string> {
  let port = startPort;
  for (;;) {
    try { return await app.listen({ port, host }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE" && port > 0 && port < 65535) {
        port++;
        continue;
      }
      throw error;
    }
  }
}

// Explicit legacy-policy transport fixture; the application CLI defaults to
// manual approval and is covered separately by the installed-package smoke.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openProjectContext } from "../../src/project/project-context.js";
import { createMcpServer } from "../../src/mcp/server.js";
const projectRoot = process.argv[2];
if (!projectRoot) throw new Error("Project root required.");
const context = await openProjectContext(projectRoot, { workflowPolicy: "reviewed-commit" });
const transport = new StdioServerTransport();
transport.onclose = () => context.database.close();
await createMcpServer(context).connect(transport);

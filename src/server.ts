#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, TOOL_INDEX } from "./tools.js";
import { getDb } from "./db.js";

const server = new Server(
  { name: "taw-mem", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOL_INDEX.get(name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  try {
    const result = await tool.handler(args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${msg}` }],
    };
  }
});

async function main() {
  // Eager-init DB so any schema/extension errors surface before stdio handshake.
  getDb();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[taw-mem] MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[taw-mem] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});

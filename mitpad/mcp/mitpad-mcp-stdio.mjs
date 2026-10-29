#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMitpadServer } from "./mitpad-mcp.mjs";

const apiKey = process.env.MITPAD_AGENT_API_KEY;
if (!apiKey) {
  console.error("Mitpad MCP local: configura MITPAD_AGENT_API_KEY.");
  process.exit(2);
}

const server = createMitpadServer(apiKey);
await server.connect(new StdioServerTransport());

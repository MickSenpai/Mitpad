#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMitpadServer } from "./mitpad-mcp.mjs";

const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;
const convexSiteUrl = process.env.MITPAD_CONVEX_SITE_URL?.replace(/\/+$/, "");
if (!convexSiteUrl || !/^https:\/\//i.test(convexSiteUrl)) throw new Error("Configura MITPAD_CONVEX_SITE_URL con una URL HTTPS.");
const extraHosts = (process.env.MITPAD_MCP_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
const allowedHosts = [...new Set([renderHost, ...extraHosts, "localhost", "127.0.0.1"].filter(Boolean))];
const allowedOrigins = new Set((process.env.MITPAD_MCP_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });

function cors(req, res) {
  const origin = req.get("Origin");
  if (!origin) return true; // Native/server-side MCP clients do not send Origin.
  if (!allowedOrigins.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "MCP-Protocol-Version, MCP-Session-Id");
  return true;
}

app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok", service: "mitpad-mcp" }));
app.options("/mcp", (req, res) => {
  if (!cors(req, res)) return res.status(403).end();
  return res.status(204).end();
});
app.post("/mcp", async (req, res) => {
  if (!cors(req, res)) return res.status(403).json({ error: "Origin no permitido." });
  const authorization = req.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match || !/^pha_[a-f0-9]{64}$/i.test(match[1])) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="Mitpad MCP"');
    return res.status(401).json({ error: "Presenta una API key válida de agente en Authorization: Bearer." });
  }

  if (req.body?.method === "initialize") {
    try {
      const check = await fetch(`${convexSiteUrl}/api/v1/agents/me`, {
        headers: { Authorization: `Bearer ${match[1]}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (check.status === 401) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="Mitpad MCP"');
        return res.status(401).json({ error: "API key inválida o revocada." });
      }
      if (!check.ok) return res.status(502).json({ error: "No se pudo validar la conexión con Mitpad." });
    } catch {
      return res.status(502).json({ error: "No se pudo contactar la API de Mitpad." });
    }
  }

  let server;
  let transport;
  try {
    server = createMitpadServer(match[1]);
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    // Never log request headers, bodies or agent keys.
    console.error("Mitpad MCP request failed:", error instanceof Error ? error.message : "unknown error");
    if (!res.headersSent) res.status(500).json({ error: "No se pudo procesar la solicitud MCP." });
  } finally {
    await transport?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST, OPTIONS").json({ error: "Usa POST para el transporte MCP Streamable HTTP." }));
app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST, OPTIONS").json({ error: "Las sesiones MCP son stateless; DELETE no aplica." }));

const port = Number(process.env.PORT ?? 3000);
const httpServer = app.listen(port, "0.0.0.0", () => {
  console.error(`Mitpad MCP escuchando en el puerto ${port}; host permitido: ${renderHost ?? "configurado por entorno"}.`);
});

async function shutdown() {
  httpServer.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

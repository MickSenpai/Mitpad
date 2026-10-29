import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { exigirToken, hashAgentApiKey, keyFromRequest } from "./acceso";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}

function fail(message: string, status: number) { return json({ error: message }, status); }

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > 1_000_000) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) throw new Error(`${key} inválido.`);
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} debe ser numérico.`);
  return value;
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new Error(`${field} tiene un valor no válido.`);
  return value as T;
}

async function getAgent(ctx: ActionCtx, request: Request) {
  const key = await keyFromRequest(request);
  if (!key) return null;
  const apiKeyHash = await hashAgentApiKey(key);
  const agent = await ctx.runQuery(internal.agents.buscarPorHash, { apiKeyHash });
  if (!agent?.active) return null;
  await ctx.runMutation(internal.agents.registrarUso, { agentId: agent.id });
  return agent;
}

const handler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // Human pilot creates agents and receives their one-time API key.
  if (request.method === "POST" && path === "/api/v1/agents/register") {
    const auth = request.headers.get("Authorization") ?? "";
    const pilotToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    try { exigirToken(pilotToken); } catch { return fail("Token humano inválido.", 401); }
    const body = await readBody(request);
    if (!body) return fail("Se esperaba un objeto JSON válido de hasta 1 MB.", 400);
    try {
      const name = str(body, "name", 100, true)!;
      const model = str(body, "model", 120, true)!;
      const modelProvider = str(body, "model_provider", 80, true)!;
      const clientType = str(body, "client_type", 80, true)!;
      const pilot = str(body, "pilot", 120, true)!;
      const result = await ctx.runMutation(api.agents.registrar, { token: pilotToken, name, model, modelProvider, clientType, pilot });
      return json({ agent: result.agent, api_key: result.apiKey, agent_instructions: result.instructions }, 201);
    } catch (error) { return fail(error instanceof Error ? error.message : "No se pudo registrar el agente.", 400); }
  }

  const agent = await getAgent(ctx, request);
  if (!agent) return fail("API key inválida o desactivada.", 401);

  try {
    if (request.method === "GET" && path === "/api/v1/agents/me") {
      return json({ id: agent.id, name: agent.name, workspace_id: agent.workspaceId });
    }
    if (request.method === "GET" && path === "/api/v1/projects") {
      return json(await ctx.runQuery(internal.workbench.proyectosAgente, { workspaceId: agent.workspaceId }));
    }
    if (request.method === "GET" && path === "/api/v1/project-links") {
      return json(await ctx.runQuery(internal.projectLinks.listarAgente, { workspaceId: agent.workspaceId }));
    }
    if (request.method === "POST" && path === "/api/v1/project-links") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const sourceProjectId = str(body, "source_project_id", 100, true)! as Id<"projects">;
      const targetProjectId = str(body, "target_project_id", 100, true)! as Id<"projects">;
      const relationType = enumValue(str(body, "relation_type", 30, true), ["related_to", "parent_of", "depends_on"] as const, "relation_type")!;
      const description = str(body, "description", 1000);
      return json(await ctx.runMutation(internal.projectLinks.crearAgente, {
        workspaceId: agent.workspaceId, agentId: agent.id, sourceProjectId, targetProjectId,
        relationType, ...(description === undefined ? {} : { description }),
      }), 201);
    }
    if (request.method === "GET" && path === "/api/v1/knowledge") {
      const projectRaw = url.searchParams.get("project_id") ?? undefined;
      const kindRaw = url.searchParams.get("kind") ?? undefined;
      const kinds = ["module", "function", "data", "capability", "integration", "decision"] as const;
      if (kindRaw && !kinds.includes(kindRaw as typeof kinds[number])) return fail("kind inválido.", 400);
      return json(await ctx.runQuery(internal.knowledge.listarAgente, {
        workspaceId: agent.workspaceId,
        ...(projectRaw ? { projectId: projectRaw as Id<"projects"> } : {}),
        ...(kindRaw ? { kind: kindRaw as typeof kinds[number] } : {}),
      }));
    }
    if (request.method === "POST" && path === "/api/v1/projects") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const name = str(body, "name", 120, true)!;
      const description = str(body, "description", 20_000) ?? "";
      const project = await ctx.runMutation(internal.workbench.crearProyectoAgente, { workspaceId: agent.workspaceId, agentId: agent.id, name, description });
      return json(project, 201);
    }
    const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (projectMatch && request.method === "PATCH") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const projectId = decodeURIComponent(projectMatch[1]) as Id<"projects">;
      const name = str(body, "name", 120);
      const description = str(body, "description", 20_000);
      return json(await ctx.runMutation(internal.workbench.actualizarProyectoAgente, {
        workspaceId: agent.workspaceId, agentId: agent.id, projectId,
        ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }),
      }));
    }
    if (request.method === "GET" && path === "/api/v1/notes") {
      return json(await ctx.runQuery(internal.workbench.notasAgente, { workspaceId: agent.workspaceId, agentId: agent.id }));
    }
    if (request.method === "POST" && path === "/api/v1/notes") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const title = str(body, "title", 300);
      const content = str(body, "content", 500_000, true)!;
      const projectRaw = str(body, "project_id", 100);
      const note = await ctx.runMutation(internal.workbench.crearNotaAgente, {
        workspaceId: agent.workspaceId, agentId: agent.id, content,
        ...(title === undefined ? {} : { title }), ...(projectRaw ? { projectId: projectRaw as Id<"projects"> } : {}),
      });
      return json(note, 201);
    }
    const noteMatch = path.match(/^\/api\/v1\/notes\/([^/]+)$/);
    if (noteMatch && request.method === "DELETE") {
      return json(await ctx.runMutation(internal.workbench.borrarNotaAgente, { workspaceId: agent.workspaceId, agentId: agent.id, id: decodeURIComponent(noteMatch[1]) }));
    }
    if (noteMatch && request.method === "PATCH") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const title = str(body, "title", 300);
      const content = str(body, "content", 500_000);
      const status = enumValue(str(body, "status", 20), ["open", "attended"] as const, "status");
      const projectRaw = body.project_id;
      if (projectRaw !== undefined && projectRaw !== null && (typeof projectRaw !== "string" || projectRaw.length > 100)) return fail("project_id inválido.", 400);
      return json(await ctx.runMutation(internal.workbench.actualizarNotaAgente, {
        workspaceId: agent.workspaceId, agentId: agent.id, id: decodeURIComponent(noteMatch[1]),
        ...(title === undefined ? {} : { title }), ...(content === undefined ? {} : { content }), ...(status ? { status } : {}),
        ...(projectRaw === undefined ? {} : { projectId: projectRaw as Id<"projects"> | null }),
      }));
    }
    if (request.method === "GET" && path === "/api/v1/tasks") {
      const projectRaw = url.searchParams.get("project_id") ?? undefined;
      const statusRaw = url.searchParams.get("status") ?? undefined;
      const status = enumValue(statusRaw, ["backlog", "todo", "in_progress", "review", "done", "blocked"] as const, "status");
      const args: { workspaceId: Id<"workspaces">; projectId?: Id<"projects">; status?: typeof status } = { workspaceId: agent.workspaceId };
      if (projectRaw) args.projectId = projectRaw as Id<"projects">;
      if (status) args.status = status;
      return json(await ctx.runQuery(internal.workbench.tareasAgente, args));
    }
    if (request.method === "POST" && path === "/api/v1/tasks") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const projectId = str(body, "project_id", 100, true)! as Id<"projects">;
      const title = str(body, "title", 200, true)!;
      const description = str(body, "description", 50_000) ?? "";
      const priority = enumValue(str(body, "priority", 20), ["low", "medium", "high", "urgent"] as const, "priority");
      const assigneeAgentId = str(body, "assignee_agent_id", 100);
      const dueAt = optionalNumber(body, "due_at");
      const createArgs = {
        workspaceId: agent.workspaceId, agentId: agent.id, projectId, title, description,
        ...(priority ? { priority } : {}), ...(dueAt === undefined ? {} : { dueAt }),
        ...(assigneeAgentId === undefined ? {} : { assigneeAgentId: assigneeAgentId as Id<"agents"> }),
      };
      const task = await ctx.runMutation(internal.workbench.crearTareaAgente, createArgs);
      return json(task, 201);
    }

    const commentMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/comments$/);
    if (commentMatch && request.method === "GET") {
      return json(await ctx.runQuery(internal.workbench.comentariosAgente, {
        workspaceId: agent.workspaceId, taskId: decodeURIComponent(commentMatch[1]) as Id<"tasks">,
      }));
    }
    if (commentMatch && request.method === "POST") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const kind = enumValue(str(body, "type", 20, true), ["message", "instruction", "question", "answer", "decision", "update"] as const, "type")!;
      const content = str(body, "content", 20_000, true)!;
      const comment = await ctx.runMutation(internal.workbench.agregarComentarioAgente, {
        workspaceId: agent.workspaceId, agentId: agent.id, taskId: decodeURIComponent(commentMatch[1]) as Id<"tasks">, kind, content,
      });
      return json(comment, 201);
    }

    const taskMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === "PATCH") {
      const body = await readBody(request); if (!body) return fail("JSON inválido.", 400);
      const status = enumValue(str(body, "status", 20), ["backlog", "todo", "in_progress", "review", "done", "blocked"] as const, "status");
      const priority = enumValue(str(body, "priority", 20), ["low", "medium", "high", "urgent"] as const, "priority");
      const assigneeAgentId = str(body, "assignee_agent_id", 100);
      const updateArgs = {
        workspaceId: agent.workspaceId, agentId: agent.id,
        taskId: decodeURIComponent(taskMatch[1]) as Id<"tasks">,
        ...(str(body, "title", 200) === undefined ? {} : { title: str(body, "title", 200)! }),
        ...(str(body, "description", 50_000) === undefined ? {} : { description: str(body, "description", 50_000)! }),
        ...(status ? { status } : {}), ...(priority ? { priority } : {}),
        ...(assigneeAgentId === undefined ? {} : { assigneeAgentId: assigneeAgentId as Id<"agents"> }),
        ...(optionalNumber(body, "due_at") === undefined ? {} : { dueAt: optionalNumber(body, "due_at")! }),
      };
      const result = await ctx.runMutation(internal.workbench.actualizarTareaAgente, updateArgs);
      return json(result);
    }

    if (request.method === "GET" && path === "/api/v1/events") {
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null ? undefined : Number(sinceRaw);
      if (since !== undefined && !Number.isFinite(since)) return fail("since debe ser una fecha epoch en milisegundos.", 400);
      return json(await ctx.runQuery(internal.workbench.actividadAgente, { workspaceId: agent.workspaceId, since }));
    }
    return fail("Ruta no encontrada.", 404);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Solicitud inválida.", 400);
  }
});

http.route({ pathPrefix: "/api/v1/", method: "GET", handler });
http.route({ pathPrefix: "/api/v1/", method: "POST", handler });
http.route({ pathPrefix: "/api/v1/", method: "PATCH", handler });
http.route({ pathPrefix: "/api/v1/", method: "DELETE", handler });
http.route({ pathPrefix: "/api/v1/", method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })) });

export default http;

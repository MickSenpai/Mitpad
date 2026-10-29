#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const keyPattern = /^pha_[a-f0-9]{64}$/i;

export function createMitpadServer(apiKey, rawBase = process.env.MITPAD_CONVEX_SITE_URL) {
  if (!rawBase) throw new Error("Configura MITPAD_CONVEX_SITE_URL.");
  const base = rawBase.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base) && !/^http:\/\/localhost(?::\d+)?$/i.test(base)) {
    throw new Error("La URL debe usar HTTPS (se permite localhost para desarrollo).");
  }
  if (!keyPattern.test(apiKey)) throw new Error("La clave de agente no tiene el formato esperado.");

  async function request(path, method = "GET", body) {
    const response = await fetch(`${base}/api/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(`Mitpad API (${response.status}): ${data?.error ?? "solicitud fallida"}`);
    return data;
  }

  function result(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  }
  function tool(server, name, description, schema, handler) {
    server.tool(name, description, schema, async (args) => {
      try { return result(await handler(args)); }
      catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
    });
  }

  const server = new McpServer({ name: "mitpad", version: "0.2.0" });
  const id = z.string().min(1).max(100);
  const taskStatus = z.enum(["backlog", "todo", "in_progress", "review", "done", "blocked"]);
  const priority = z.enum(["low", "medium", "high", "urgent"]);

  tool(server, "mitpad_projects_list", "Lista los proyectos del workspace Mitpad.", {}, () => request("projects"));
  tool(server, "mitpad_project_links_list", "Lee las relaciones descritas entre proyectos.", {}, () => request("project-links"));
  tool(server, "mitpad_project_link_create", "Crea o actualiza una relación descrita entre dos proyectos del workspace.", { source_project_id: id, target_project_id: id, relation_type: z.enum(["related_to", "parent_of", "depends_on"]), description: z.string().max(1000).optional() }, (a) => request("project-links", "POST", a));
  tool(server, "mitpad_knowledge_list", "Consulta funciones, datos, módulos, integraciones y decisiones documentadas en el mapa.", { project_id: id.optional(), kind: z.enum(["module", "function", "data", "capability", "integration", "decision"]).optional() }, ({ project_id, kind }) => {
    const query = new URLSearchParams(); if (project_id) query.set("project_id", project_id); if (kind) query.set("kind", kind);
    return request(`knowledge${query.size ? `?${query}` : ""}`);
  });
  tool(server, "mitpad_projects_create", "Crea un proyecto en Mitpad.", { name: z.string().min(1).max(120), description: z.string().max(20_000).optional() }, (a) => request("projects", "POST", a));
  tool(server, "mitpad_projects_update", "Edita el nombre o contexto de un proyecto existente.", { project_id: id, name: z.string().min(1).max(120).optional(), description: z.string().max(20_000).optional() }, ({ project_id, ...body }) => request(`projects/${encodeURIComponent(project_id)}`, "PATCH", body));
  tool(server, "mitpad_projects_delete", "Elimina permanentemente un proyecto solo cuando el usuario lo solicite. Borra sus tareas, comentarios, contexto y relaciones; conserva notas e imágenes y las deja sin proyecto.", { project_id: id }, ({ project_id }) => request(`projects/${encodeURIComponent(project_id)}`, "DELETE"));

  tool(server, "mitpad_tasks_list", "Consulta tareas; permite filtrar por proyecto y estado.", { project_id: id.optional(), status: taskStatus.optional() }, ({ project_id, status }) => {
    const query = new URLSearchParams(); if (project_id) query.set("project_id", project_id); if (status) query.set("status", status);
    return request(`tasks${query.size ? `?${query}` : ""}`);
  });
  tool(server, "mitpad_tasks_create", "Crea una tarea dentro de un proyecto.", { project_id: id, title: z.string().min(1).max(200), description: z.string().max(50_000).optional(), priority: priority.optional(), due_at: z.number().finite().optional(), assignee_agent_id: id.optional() }, (a) => request("tasks", "POST", a));
  tool(server, "mitpad_tasks_update", "Actualiza estado, prioridad, asignación o contenido de una tarea.", { task_id: id, title: z.string().min(1).max(200).optional(), description: z.string().max(50_000).optional(), status: taskStatus.optional(), priority: priority.optional(), due_at: z.number().finite().optional(), assignee_agent_id: id.optional() }, ({ task_id, ...body }) => request(`tasks/${encodeURIComponent(task_id)}`, "PATCH", body));

  tool(server, "mitpad_notes_list", "Lee las notas persistentes del workspace.", {}, () => request("notes"));
  tool(server, "mitpad_notes_create", "Guarda una nota para el piloto y los agentes.", { title: z.string().max(300).optional(), content: z.string().min(1).max(500_000), project_id: id.optional() }, (a) => request("notes", "POST", a));
  tool(server, "mitpad_notes_update", "Edita o marca como atendida una nota existente.", { note_id: id, title: z.string().max(300).optional(), content: z.string().max(500_000).optional(), status: z.enum(["open", "attended"]).optional(), project_id: id.nullable().optional() }, ({ note_id, ...body }) => request(`notes/${encodeURIComponent(note_id)}`, "PATCH", body));
  tool(server, "mitpad_notes_delete", "Elimina permanentemente una nota y sus adjuntos. Úsala solo cuando el usuario solicite borrar esa nota.", { note_id: id }, ({ note_id }) => request(`notes/${encodeURIComponent(note_id)}`, "DELETE"));

  tool(server, "mitpad_task_comments_list", "Lee la conversación asociada a una tarea.", { task_id: id }, ({ task_id }) => request(`tasks/${encodeURIComponent(task_id)}/comments`));
  tool(server, "mitpad_task_comment_add", "Agrega un mensaje, instrucción, pregunta, respuesta, decisión o actualización a una tarea.", { task_id: id, type: z.enum(["message", "instruction", "question", "answer", "decision", "update"]), content: z.string().min(1).max(20_000) }, ({ task_id, ...body }) => request(`tasks/${encodeURIComponent(task_id)}/comments`, "POST", body));
  tool(server, "mitpad_activity_list", "Consulta actividad reciente desde una fecha epoch opcional en milisegundos.", { since: z.number().finite().optional() }, ({ since }) => request(`events${since === undefined ? "" : `?since=${encodeURIComponent(String(since))}`}`));

  return server;
}

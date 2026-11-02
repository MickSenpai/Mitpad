#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpath, readFile, stat } from "node:fs/promises";
import { fetchWithRetry } from "./fetch-with-retry.mjs";

const keyPattern = /^pha_[a-f0-9]{64}$/i;

const FILE_TYPES_BY_EXTENSION = new Map([
  [".pdf", "application/pdf"], [".txt", "text/plain"], [".md", "text/markdown"], [".markdown", "text/markdown"],
  [".csv", "text/csv"], [".json", "application/json"], [".rtf", "application/rtf"], [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"], [".odt", "application/vnd.oasis.opendocument.text"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"], [".odp", "application/vnd.oasis.opendocument.presentation"], [".zip", "application/zip"],
]);

export function createMitpadServer(apiKey, rawBase = process.env.MITPAD_CONVEX_SITE_URL, { localFileAccess = false } = {}) {
  if (!rawBase) throw new Error("Configura MITPAD_CONVEX_SITE_URL.");
  const base = rawBase.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base) && !/^http:\/\/localhost(?::\d+)?$/i.test(base)) {
    throw new Error("La URL debe usar HTTPS (se permite localhost para desarrollo).");
  }
  if (!keyPattern.test(apiKey)) throw new Error("La clave de agente no tiene el formato esperado.");

  async function request(path, method = "GET", body) {
    const response = await fetchWithRetry(`${base}/api/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, { timeoutMs: 12_000, retries: 1 });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(`Mitpad API (${response.status}): ${data?.error ?? "solicitud fallida"}`);
    return data;
  }

  async function uploadBuffer(projectId, filename, contentType, bytes, tags = []) {
    if (bytes.byteLength < 1 || bytes.byteLength > 25 * 1024 * 1024) throw new Error("El archivo debe pesar entre 1 byte y 25 MB.");
    if (![...FILE_TYPES_BY_EXTENSION.values()].includes(contentType)) throw new Error("Formato de archivo no admitido.");
    const preparation = await request("files/upload-url", "POST", { project_id: projectId });
    const uploaded = await fetchWithRetry(preparation.upload_url, {
      method: "POST", headers: { "Content-Type": contentType }, body: bytes,
    }, { timeoutMs: 120_000, retries: 0 });
    if (!uploaded.ok) throw new Error(`La carga binaria falló (${uploaded.status}).`);
    const { storageId } = await uploaded.json();
    return await request("files/register", "POST", {
      project_id: projectId, filename, storage_id: storageId, tags,
    });
  }

  function result(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  }
  function tool(server, name, description, schema, handler) {
    const readOnly = /_(list|comments_list|activity_list)$/.test(name);
    const destructive = /_(delete|remove|revoke)$/.test(name);
    server.tool(name, description, schema, {
      ...(readOnly ? { readOnlyHint: true } : {}),
      ...(destructive ? { destructiveHint: true } : {}),
      openWorldHint: false,
    }, async (args) => {
      try { return result(await handler(args)); }
      catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
    });
  }

  const server = new McpServer({ name: "mitpad", version: "0.4.0" }, {
    instructions: "Mitpad is a private project workspace. Start with read-only list tools to learn the workspace. When uploading a file, find the exact project with mitpad_projects_list and pass its ID; upload tools register the file directly under that project. You may relink an existing workspace file with mitpad_files_link. In local stdio mode, mitpad_files_upload_local reads only files inside MITPAD_UPLOAD_ROOT (or the process working directory when unset). Use the user's language and summarize what changed. Only create, edit, upload, link, or delete data when the user asks. Project and note deletion are permanent. If a tool fails, report the error instead of claiming success.",
  });
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

  tool(server, "mitpad_files_list", "Lista archivos del workspace o de un proyecto, con nombre, etiquetas, tamaño y enlace de descarga.", { project_id: id.optional() }, ({ project_id }) => {
    const query = project_id ? `?project_id=${encodeURIComponent(project_id)}` : "";
    return request(`files${query}`);
  });
  tool(server, "mitpad_files_link", "Vincula un archivo existente a un proyecto del workspace o lo deja sin proyecto.", { file_id: id, project_id: id.nullable() }, ({ file_id, project_id }) => request(`files/${encodeURIComponent(file_id)}`, "PATCH", { project_id }));
  tool(server, "mitpad_files_upload_text", "Crea un archivo Markdown, texto, CSV o JSON con el contenido proporcionado y lo vincula al proyecto elegido. Para preservar archivos locales binarios, configura MCP por stdio y usa mitpad_files_upload_local.", {
    project_id: id, filename: z.string().min(1).max(255), content: z.string().min(1).max(20_000),
    format: z.enum(["markdown", "text", "csv", "json"]).default("markdown"),
    tags: z.array(z.string().max(32)).max(10).optional(),
  }, async ({ project_id, filename, content, format, tags }) => {
    const typeByFormat = { markdown: "text/markdown", text: "text/plain", csv: "text/csv", json: "application/json" };
    return await uploadBuffer(project_id, filename, typeByFormat[format], Buffer.from(content, "utf8"), tags ?? []);
  });

  if (localFileAccess) {
    tool(server, "mitpad_files_upload_local", "Sube el archivo original desde el equipo local y lo enlaza al proyecto. Solo lee rutas dentro de MITPAD_UPLOAD_ROOT (por defecto, la carpeta desde la que se inició el cliente MCP). Úsalo solo cuando el usuario pida cargar ese archivo.", {
      project_id: id, path: z.string().min(1).max(2000), filename: z.string().min(1).max(255).optional(),
      tags: z.array(z.string().max(32)).max(10).optional(),
    }, async ({ project_id, path, filename, tags }) => {
      const root = await realpath(resolve(process.env.MITPAD_UPLOAD_ROOT ?? process.cwd()));
      const absolute = await realpath(isAbsolute(path) ? path : resolve(root, path));
      const relativePath = relative(root, absolute);
      if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("La ruta está fuera de MITPAD_UPLOAD_ROOT.");
      const metadata = await stat(absolute);
      if (!metadata.isFile()) throw new Error("La ruta no apunta a un archivo regular.");
      if (metadata.size < 1 || metadata.size > 25 * 1024 * 1024) throw new Error("El archivo debe pesar entre 1 byte y 25 MB.");
      const name = filename?.trim() || basename(absolute);
      const contentType = FILE_TYPES_BY_EXTENSION.get(extname(name).toLowerCase());
      if (!contentType) throw new Error("Formato no admitido. Usa PDF, texto/Markdown, CSV/JSON, Office, OpenDocument o ZIP.");
      const bytes = await readFile(absolute);
      return await uploadBuffer(project_id, name, contentType, bytes, tags ?? []);
    });
  }

  tool(server, "mitpad_task_comments_list", "Lee la conversación asociada a una tarea.", { task_id: id }, ({ task_id }) => request(`tasks/${encodeURIComponent(task_id)}/comments`));
  tool(server, "mitpad_task_comment_add", "Agrega un mensaje, instrucción, pregunta, respuesta, decisión o actualización a una tarea.", { task_id: id, type: z.enum(["message", "instruction", "question", "answer", "decision", "update"]), content: z.string().min(1).max(20_000) }, ({ task_id, ...body }) => request(`tasks/${encodeURIComponent(task_id)}/comments`, "POST", body));
  tool(server, "mitpad_activity_list", "Consulta actividad reciente desde una fecha epoch opcional en milisegundos.", { since: z.number().finite().optional() }, ({ since }) => request(`events${since === undefined ? "" : `?since=${encodeURIComponent(String(since))}`}`));

  return server;
}

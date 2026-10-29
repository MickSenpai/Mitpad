import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { exigirToken, userIdPersonal } from "./acceso";
import { asegurarWorkspace } from "./workspaces";

const projectStatus = v.union(v.literal("active"), v.literal("archived"));
const taskStatus = v.union(v.literal("backlog"), v.literal("todo"), v.literal("in_progress"), v.literal("review"), v.literal("done"), v.literal("blocked"));
const taskPriority = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"));
const commentKind = v.union(v.literal("message"), v.literal("instruction"), v.literal("question"), v.literal("answer"), v.literal("decision"), v.literal("update"));
const actorType = v.union(v.literal("human"), v.literal("agent"));

const projectValidator = v.object({
  id: v.id("projects"), workspaceId: v.id("workspaces"), clientId: v.union(v.string(), v.null()), name: v.string(), description: v.string(),
  status: projectStatus, createdByType: actorType, createdById: v.string(), createdAt: v.number(), updatedAt: v.number(),
});
const taskValidator = v.object({
  id: v.id("tasks"), workspaceId: v.id("workspaces"), clientId: v.union(v.string(), v.null()), projectId: v.id("projects"),
  parentTaskId: v.union(v.id("tasks"), v.null()), title: v.string(), description: v.string(),
  status: taskStatus, priority: taskPriority, dueAt: v.union(v.number(), v.null()),
  assigneeAgentId: v.union(v.id("agents"), v.null()), createdByType: actorType,
  createdById: v.string(), createdAt: v.number(), updatedAt: v.number(),
});
const commentValidator = v.object({
  id: v.id("taskComments"), workspaceId: v.id("workspaces"), clientId: v.union(v.string(), v.null()), projectId: v.id("projects"), taskId: v.id("tasks"),
  authorType: actorType, authorId: v.string(), kind: commentKind, content: v.string(), createdAt: v.number(),
});
const eventValidator = v.object({
  id: v.id("activityEvents"), workspaceId: v.id("workspaces"), projectId: v.union(v.id("projects"), v.null()),
  actorType, actorId: v.string(), eventType: v.union(v.literal("project_created"), v.literal("project_updated"), v.literal("project_archived"), v.literal("project_deleted"), v.literal("task_created"), v.literal("task_updated"), v.literal("comment_created"), v.literal("agent_registered"), v.literal("agent_updated"), v.literal("agent_revoked"), v.literal("note_created"), v.literal("note_updated"), v.literal("note_linked"), v.literal("note_deleted")),
  entityType: v.union(v.literal("project"), v.literal("task"), v.literal("comment"), v.literal("agent"), v.literal("note")),
  entityId: v.string(), summary: v.string(), details: v.union(v.string(), v.null()), createdAt: v.number(),
});

type Actor = { kind: "human" | "agent"; id: string };

const publicProject = (doc: Doc<"projects">) => ({
  id: doc._id, workspaceId: doc.workspaceId, clientId: doc.clientId ?? null, name: doc.name, description: doc.description,
  status: doc.status, createdByType: doc.createdByType, createdById: doc.createdById,
  createdAt: doc.createdAt, updatedAt: doc.updatedAt,
});
const publicTask = (doc: Doc<"tasks">) => ({
  id: doc._id, workspaceId: doc.workspaceId, clientId: doc.clientId ?? null, projectId: doc.projectId, parentTaskId: doc.parentTaskId ?? null,
  title: doc.title, description: doc.description, status: doc.status, priority: doc.priority,
  dueAt: doc.dueAt ?? null, assigneeAgentId: doc.assigneeAgentId ?? null,
  createdByType: doc.createdByType, createdById: doc.createdById, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
});
const publicComment = (doc: Doc<"taskComments">) => ({
  id: doc._id, workspaceId: doc.workspaceId, clientId: doc.clientId ?? null, projectId: doc.projectId, taskId: doc.taskId,
  authorType: doc.authorType, authorId: doc.authorId, kind: doc.kind, content: doc.content, createdAt: doc.createdAt,
});
const publicEvent = (doc: Doc<"activityEvents">) => ({
  id: doc._id, workspaceId: doc.workspaceId, projectId: doc.projectId ?? null,
  actorType: doc.actorType, actorId: doc.actorId, eventType: doc.eventType,
  entityType: doc.entityType, entityId: doc.entityId, summary: doc.summary,
  details: doc.details ?? null, createdAt: doc.createdAt,
});

async function personalWorkspace(ctx: QueryCtx | MutationCtx) {
  return await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal())).unique();
}

async function ensureAgent(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">, agentId: Id<"agents">) {
  const agent = await ctx.db.get(agentId);
  if (!agent || !agent.active || agent.workspaceId !== workspaceId) throw new Error("El agente no pertenece a este espacio o está desactivado.");
  return agent;
}

async function ensureProject(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (!project || project.workspaceId !== workspaceId) throw new Error("El proyecto no pertenece a este espacio.");
  return project;
}

async function addEvent(ctx: MutationCtx, args: {
  workspaceId: Id<"workspaces">; projectId?: Id<"projects">; actor: Actor;
  eventType: Doc<"activityEvents">["eventType"]; entityType: Doc<"activityEvents">["entityType"];
  entityId: string; summary: string; details?: string;
}) {
  await ctx.db.insert("activityEvents", {
    workspaceId: args.workspaceId, projectId: args.projectId, actorType: args.actor.kind,
    actorId: args.actor.id, eventType: args.eventType, entityType: args.entityType,
    entityId: args.entityId, summary: args.summary.slice(0, 300), details: args.details?.slice(0, 20_000), createdAt: Date.now(),
  });
}

async function createProject(ctx: MutationCtx, workspaceId: Id<"workspaces">, actor: Actor, name: string, description: string) {
  validarTexto(name, "Nombre", 120);
  if (description.length > 20_000) throw new Error("La descripción del proyecto supera 20.000 caracteres.");
  const now = Date.now();
  const id = await ctx.db.insert("projects", {
    workspaceId, name: name.trim(), description: description.trim(), status: "active",
    createdByType: actor.kind, createdById: actor.id, createdAt: now, updatedAt: now,
  });
  await addEvent(ctx, { workspaceId, projectId: id, actor, eventType: "project_created", entityType: "project", entityId: id, summary: `Creó el proyecto ${name.trim()}` });
  const project = await ctx.db.get(id);
  if (!project) throw new Error("No se pudo crear el proyecto.");
  return publicProject(project);
}

async function updateProject(ctx: MutationCtx, workspaceId: Id<"workspaces">, agentId: Id<"agents">, projectId: Id<"projects">, patch: { name?: string; description?: string }) {
  const agent = await ensureAgent(ctx, workspaceId, agentId);
  const current = await ensureProject(ctx, workspaceId, projectId);
  if (patch.name !== undefined) validarTexto(patch.name, "Nombre", 120);
  if (patch.description !== undefined && patch.description.length > 20_000) throw new Error("La descripción supera 20.000 caracteres.");
  const changes: { name?: string; description?: string; updatedAt: number } = { updatedAt: Date.now() };
  if (patch.name !== undefined) changes.name = patch.name.trim();
  if (patch.description !== undefined) changes.description = patch.description.trim();
  await ctx.db.patch(projectId, changes);
  await addEvent(ctx, { workspaceId, projectId, actor: { kind: "agent", id: agent._id }, eventType: "project_updated", entityType: "project", entityId: projectId, summary: `Actualizó el proyecto ${patch.name?.trim() ?? current.name}` });
  const updated = await ctx.db.get(projectId);
  if (!updated) throw new Error("No se pudo recuperar el proyecto actualizado.");
  return publicProject(updated);
}

function validarTexto(value: string, name: string, max: number) {
  if (!value.trim() || value.length > max) throw new Error(`${name} es obligatorio y debe tener máximo ${max} caracteres.`);
}

async function listProjects(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  const docs = await ctx.db.query("projects").withIndex("by_workspaceId_and_updatedAt", (q) => q.eq("workspaceId", workspaceId)).order("desc").take(200);
  return docs.map(publicProject);
}

async function listTasks(ctx: QueryCtx, workspaceId: Id<"workspaces">, projectId?: Id<"projects">, status?: Doc<"tasks">["status"]) {
  if (projectId) {
    await ensureProject(ctx, workspaceId, projectId);
    const docs = status
      ? await ctx.db.query("tasks").withIndex("by_projectId_and_status_and_updatedAt", (q) => q.eq("projectId", projectId).eq("status", status)).order("desc").take(200)
      : await ctx.db.query("tasks").withIndex("by_projectId_and_updatedAt", (q) => q.eq("projectId", projectId)).order("desc").take(200);
    return docs.map(publicTask);
  }
  const docs = status
    ? await ctx.db.query("tasks").withIndex("by_workspaceId_and_status_and_updatedAt", (q) => q.eq("workspaceId", workspaceId).eq("status", status)).order("desc").take(200)
    : await ctx.db.query("tasks").withIndex("by_workspaceId_and_updatedAt", (q) => q.eq("workspaceId", workspaceId)).order("desc").take(200);
  return docs.map(publicTask);
}

async function createTask(ctx: MutationCtx, workspaceId: Id<"workspaces">, actor: Actor, args: {
  projectId: Id<"projects">; title: string; description: string; priority: Doc<"tasks">["priority"];
  dueAt?: number; assigneeAgentId?: Id<"agents">; parentTaskId?: Id<"tasks">;
}) {
  await ensureProject(ctx, workspaceId, args.projectId);
  validarTexto(args.title, "Título", 200);
  if (args.description.length > 50_000) throw new Error("La descripción de la tarea supera 50.000 caracteres.");
  if (args.assigneeAgentId) await ensureAgent(ctx, workspaceId, args.assigneeAgentId);
  if (args.parentTaskId) {
    const parent = await ctx.db.get(args.parentTaskId);
    if (!parent || parent.projectId !== args.projectId) throw new Error("La tarea padre debe estar en el mismo proyecto.");
  }
  const now = Date.now();
  const id = await ctx.db.insert("tasks", {
    workspaceId, projectId: args.projectId, parentTaskId: args.parentTaskId,
    title: args.title.trim(), description: args.description.trim(), status: "todo", priority: args.priority,
    dueAt: args.dueAt, assigneeAgentId: args.assigneeAgentId,
    createdByType: actor.kind, createdById: actor.id, createdAt: now, updatedAt: now,
  });
  await addEvent(ctx, { workspaceId, projectId: args.projectId, actor, eventType: "task_created", entityType: "task", entityId: id, summary: `Creó la tarea ${args.title.trim()}` });
  const task = await ctx.db.get(id);
  if (!task) throw new Error("No se pudo crear la tarea.");
  return publicTask(task);
}

async function updateTask(ctx: MutationCtx, workspaceId: Id<"workspaces">, actor: Actor, taskId: Id<"tasks">, patch: {
  title?: string; description?: string; status?: Doc<"tasks">["status"]; priority?: Doc<"tasks">["priority"];
  dueAt?: number; assigneeAgentId?: Id<"agents">; projectId?: Id<"projects">;
}) {
  const current = await ctx.db.get(taskId);
  if (!current || current.workspaceId !== workspaceId) throw new Error("La tarea no pertenece a este espacio.");
  if (patch.projectId) await ensureProject(ctx, workspaceId, patch.projectId);
  if (patch.title !== undefined) validarTexto(patch.title, "Título", 200);
  if (patch.description !== undefined && patch.description.length > 50_000) throw new Error("La descripción de la tarea supera 50.000 caracteres.");
  if (patch.assigneeAgentId) await ensureAgent(ctx, workspaceId, patch.assigneeAgentId);
  const changes: Record<string, string | number | Id<"agents"> | Id<"projects"> | undefined> = {};
  if (patch.title !== undefined) changes.title = patch.title.trim();
  if (patch.description !== undefined) changes.description = patch.description.trim();
  if (patch.status !== undefined) changes.status = patch.status;
  if (patch.priority !== undefined) changes.priority = patch.priority;
  if (patch.dueAt !== undefined) changes.dueAt = patch.dueAt;
  if (patch.assigneeAgentId !== undefined) changes.assigneeAgentId = patch.assigneeAgentId;
  if (patch.projectId !== undefined) changes.projectId = patch.projectId;
  if (Object.keys(changes).length === 0) throw new Error("No hay cambios para guardar.");
  changes.updatedAt = Date.now();
  await ctx.db.patch(taskId, changes);
  const updated = await ctx.db.get(taskId);
  if (!updated) throw new Error("No se pudo recuperar la tarea actualizada.");
  const details = JSON.stringify({ from: { status: current.status, projectId: current.projectId }, to: { status: updated.status, projectId: updated.projectId } });
  await addEvent(ctx, { workspaceId, projectId: updated.projectId, actor, eventType: "task_updated", entityType: "task", entityId: taskId, summary: `Actualizó la tarea ${updated.title}`, details });
  return publicTask(updated);
}

async function addComment(ctx: MutationCtx, workspaceId: Id<"workspaces">, actor: Actor, taskId: Id<"tasks">, kind: Doc<"taskComments">["kind"], content: string) {
  const task = await ctx.db.get(taskId);
  if (!task || task.workspaceId !== workspaceId) throw new Error("La tarea no pertenece a este espacio.");
  validarTexto(content, "Comentario", 20_000);
  const now = Date.now();
  const id = await ctx.db.insert("taskComments", {
    workspaceId, projectId: task.projectId, taskId, authorType: actor.kind, authorId: actor.id,
    kind, content: content.trim(), createdAt: now,
  });
  await addEvent(ctx, { workspaceId, projectId: task.projectId, actor, eventType: "comment_created", entityType: "comment", entityId: id, summary: `Comentó en ${task.title}`, details: content.trim().slice(0, 20_000) });
  const comment = await ctx.db.get(id);
  if (!comment) throw new Error("No se pudo crear el comentario.");
  return publicComment(comment);
}

async function listEvents(ctx: QueryCtx, workspaceId: Id<"workspaces">, since?: number) {
  const docs = since !== undefined
    ? await ctx.db.query("activityEvents").withIndex("by_workspaceId_and_createdAt", (q) => q.eq("workspaceId", workspaceId).gte("createdAt", since)).order("desc").take(200)
    : await ctx.db.query("activityEvents").withIndex("by_workspaceId_and_createdAt", (q) => q.eq("workspaceId", workspaceId)).order("desc").take(200);
  return docs.map(publicEvent);
}

// ------------------------ Human pilot API ------------------------

export const proyectos = query({
  args: { token: v.string() }, returns: v.array(projectValidator),
  handler: async (ctx, { token }) => { exigirToken(token); const w = await personalWorkspace(ctx); return w ? listProjects(ctx, w._id) : []; },
});

export const crearProyecto = mutation({
  args: { token: v.string(), name: v.string(), description: v.optional(v.string()) }, returns: projectValidator,
  handler: async (ctx, { token, name, description }) => {
    exigirToken(token); const workspaceId = await asegurarWorkspace(ctx, userIdPersonal());
    return createProject(ctx, workspaceId, { kind: "human", id: "pilot" }, name, description ?? "");
  },
});

export const tareas = query({
  args: { token: v.string(), projectId: v.optional(v.id("projects")), status: v.optional(taskStatus) }, returns: v.array(taskValidator),
  handler: async (ctx, { token, projectId, status }) => { exigirToken(token); const w = await personalWorkspace(ctx); return w ? listTasks(ctx, w._id, projectId, status) : []; },
});

export const crearTarea = mutation({
  args: {
    token: v.string(), projectId: v.id("projects"), title: v.string(), description: v.optional(v.string()),
    priority: v.optional(taskPriority), dueAt: v.optional(v.number()), assigneeAgentId: v.optional(v.id("agents")),
    parentTaskId: v.optional(v.id("tasks")),
  }, returns: taskValidator,
  handler: async (ctx, args) => {
    exigirToken(args.token); const w = await personalWorkspace(ctx);
    if (!w) throw new Error("Crea primero el espacio personal.");
    return createTask(ctx, w._id, { kind: "human", id: "pilot" }, {
      projectId: args.projectId, title: args.title, description: args.description ?? "", priority: args.priority ?? "medium",
      dueAt: args.dueAt, assigneeAgentId: args.assigneeAgentId, parentTaskId: args.parentTaskId,
    });
  },
});

export const actualizarTarea = mutation({
  args: {
    token: v.string(), taskId: v.id("tasks"), title: v.optional(v.string()), description: v.optional(v.string()),
    status: v.optional(taskStatus), priority: v.optional(taskPriority), dueAt: v.optional(v.number()),
    assigneeAgentId: v.optional(v.id("agents")), projectId: v.optional(v.id("projects")),
  }, returns: taskValidator,
  handler: async (ctx, args) => {
    exigirToken(args.token); const w = await personalWorkspace(ctx);
    if (!w) throw new Error("No existe el espacio personal.");
    const { token: _token, taskId, ...patch } = args;
    return updateTask(ctx, w._id, { kind: "human", id: "pilot" }, taskId, patch);
  },
});

export const comentarios = query({
  args: { token: v.string(), taskId: v.id("tasks") }, returns: v.array(commentValidator),
  handler: async (ctx, { token, taskId }) => {
    exigirToken(token); const w = await personalWorkspace(ctx); if (!w) return [];
    const task = await ctx.db.get(taskId); if (!task || task.workspaceId !== w._id) throw new Error("La tarea no pertenece a este espacio.");
    const docs = await ctx.db.query("taskComments").withIndex("by_taskId_and_createdAt", (q) => q.eq("taskId", taskId)).order("asc").take(500);
    return docs.map(publicComment);
  },
});

export const agregarComentario = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), kind: commentKind, content: v.string() }, returns: commentValidator,
  handler: async (ctx, { token, taskId, kind, content }) => {
    exigirToken(token); const w = await personalWorkspace(ctx); if (!w) throw new Error("No existe el espacio personal.");
    return addComment(ctx, w._id, { kind: "human", id: "pilot" }, taskId, kind, content);
  },
});

export const actividad = query({
  args: { token: v.string(), since: v.optional(v.number()) }, returns: v.array(eventValidator),
  handler: async (ctx, { token, since }) => { exigirToken(token); const w = await personalWorkspace(ctx); return w ? listEvents(ctx, w._id, since) : []; },
});

// -------------------------- Agent REST API -------------------------

export const proyectosAgente = internalQuery({
  args: { workspaceId: v.id("workspaces") }, returns: v.array(projectValidator),
  handler: async (ctx, { workspaceId }) => listProjects(ctx, workspaceId),
});

export const crearProyectoAgente = internalMutation({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents"), name: v.string(), description: v.optional(v.string()) }, returns: projectValidator,
  handler: async (ctx, { workspaceId, agentId, name, description }) => {
    const agent = await ensureAgent(ctx, workspaceId, agentId);
    return createProject(ctx, workspaceId, { kind: "agent", id: agent._id }, name, description ?? "");
  },
});

export const tareasAgente = internalQuery({
  args: { workspaceId: v.id("workspaces"), projectId: v.optional(v.id("projects")), status: v.optional(taskStatus) }, returns: v.array(taskValidator),
  handler: async (ctx, args) => listTasks(ctx, args.workspaceId, args.projectId, args.status),
});

export const crearTareaAgente = internalMutation({
  args: {
    workspaceId: v.id("workspaces"), agentId: v.id("agents"), projectId: v.id("projects"), title: v.string(),
    description: v.optional(v.string()), priority: v.optional(taskPriority), dueAt: v.optional(v.number()),
    assigneeAgentId: v.optional(v.id("agents")), parentTaskId: v.optional(v.id("tasks")),
  }, returns: taskValidator,
  handler: async (ctx, args) => {
    const agent = await ensureAgent(ctx, args.workspaceId, args.agentId);
    return createTask(ctx, args.workspaceId, { kind: "agent", id: agent._id }, {
      projectId: args.projectId, title: args.title, description: args.description ?? "", priority: args.priority ?? "medium",
      dueAt: args.dueAt, assigneeAgentId: args.assigneeAgentId, parentTaskId: args.parentTaskId,
    });
  },
});

export const actualizarTareaAgente = internalMutation({
  args: {
    workspaceId: v.id("workspaces"), agentId: v.id("agents"), taskId: v.id("tasks"), title: v.optional(v.string()),
    description: v.optional(v.string()), status: v.optional(taskStatus), priority: v.optional(taskPriority),
    dueAt: v.optional(v.number()), assigneeAgentId: v.optional(v.id("agents")), projectId: v.optional(v.id("projects")),
  }, returns: taskValidator,
  handler: async (ctx, args) => {
    const agent = await ensureAgent(ctx, args.workspaceId, args.agentId);
    const { workspaceId, agentId, taskId, ...patch } = args;
    return updateTask(ctx, workspaceId, { kind: "agent", id: agent._id }, taskId, patch);
  },
});

export const actualizarProyectoAgente = internalMutation({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents"), projectId: v.id("projects"), name: v.optional(v.string()), description: v.optional(v.string()) },
  returns: projectValidator,
  handler: async (ctx, args) => {
    const { workspaceId, agentId, projectId, ...patch } = args;
    return updateProject(ctx, workspaceId, agentId, projectId, patch);
  },
});

async function deleteProjectCascade(ctx: MutationCtx, workspaceId: Id<"workspaces">, actor: Actor, projectId: Id<"projects">) {
  const project = await ensureProject(ctx, workspaceId, projectId);

  // Keep durable memory and files; remove only their association with the project.
  for await (const note of ctx.db.query("notes").withIndex("by_projectId", q => q.eq("projectId", projectId))) {
    if (note.workspaceId === workspaceId) await ctx.db.patch(note._id, { projectId: undefined, updatedAt: Date.now() });
  }
  for await (const image of ctx.db.query("noteImages").withIndex("by_projectId_and_createdAt", q => q.eq("projectId", projectId))) {
    if (image.workspaceId === workspaceId) await ctx.db.patch(image._id, { projectId: undefined });
  }

  for await (const task of ctx.db.query("tasks").withIndex("by_projectId_and_updatedAt", q => q.eq("projectId", projectId))) {
    if (task.workspaceId !== workspaceId) continue;
    for await (const comment of ctx.db.query("taskComments").withIndex("by_taskId_and_createdAt", q => q.eq("taskId", task._id))) {
      if (comment.workspaceId === workspaceId) await ctx.db.delete(comment._id);
    }
    await ctx.db.delete(task._id);
  }
  for await (const item of ctx.db.query("projectKnowledge").withIndex("by_workspaceId_and_projectId", q => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
    await ctx.db.delete(item._id);
  }
  for await (const link of ctx.db.query("projectLinks").withIndex("by_sourceProjectId_and_targetProjectId", q => q.eq("sourceProjectId", projectId))) {
    if (link.workspaceId === workspaceId) await ctx.db.delete(link._id);
  }
  for await (const link of ctx.db.query("projectLinks").withIndex("by_targetProjectId", q => q.eq("targetProjectId", projectId))) {
    if (link.workspaceId === workspaceId) await ctx.db.delete(link._id);
  }
  for await (const event of ctx.db.query("activityEvents").withIndex("by_projectId_and_createdAt", q => q.eq("projectId", projectId))) {
    if (event.workspaceId === workspaceId) await ctx.db.patch(event._id, { projectId: undefined });
  }

  await ctx.db.delete(projectId);
  await addEvent(ctx, { workspaceId, actor, eventType: "project_deleted", entityType: "project", entityId: projectId, summary: `Eliminó el proyecto ${project.name}` });
  return { deleted: true as const, projectName: project.name };
}

export const borrarProyectoAgente = internalMutation({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents"), projectId: v.id("projects") },
  returns: v.object({ deleted: v.boolean(), projectName: v.string() }),
  handler: async (ctx, args) => {
    const agent = await ensureAgent(ctx, args.workspaceId, args.agentId);
    return deleteProjectCascade(ctx, args.workspaceId, { kind: "agent", id: agent._id }, args.projectId);
  },
});

const agentNoteValidator = v.object({
  id: v.string(), title: v.union(v.string(), v.null()), content: v.string(), status: v.union(v.literal("open"), v.literal("attended")),
  project_id: v.union(v.id("projects"), v.null()), created_at: v.number(), updated_at: v.number(),
});
const publicAgentNote = (note: Doc<"notes">) => ({ id: note.uuid, title: note.title ?? null, content: note.content, status: note.status ?? "open" as const, project_id: note.projectId ?? null, created_at: note.createdAt, updated_at: note.updatedAt });

export const notasAgente = internalQuery({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents") }, returns: v.array(agentNoteValidator),
  handler: async (ctx, { workspaceId, agentId }) => {
    await ensureAgent(ctx, workspaceId, agentId);
    const notes = await ctx.db.query("notes").withIndex("by_workspaceId_and_updatedAt", (q) => q.eq("workspaceId", workspaceId)).order("desc").take(500);
    return notes.filter((note) => note.deletedAt === undefined).map(publicAgentNote);
  },
});

export const crearNotaAgente = internalMutation({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents"), title: v.optional(v.string()), content: v.string(), projectId: v.optional(v.id("projects")) },
  returns: agentNoteValidator,
  handler: async (ctx, args) => {
    const agent = await ensureAgent(ctx, args.workspaceId, args.agentId);
    if (args.title !== undefined && args.title.length > 300) throw new Error("El título supera 300 caracteres.");
    if (args.content.length > 500_000) throw new Error("La nota supera 500.000 caracteres.");
    if (args.projectId) await ensureProject(ctx, args.workspaceId, args.projectId);
    const now = Date.now(); const uuid = crypto.randomUUID();
    const id = await ctx.db.insert("notes", { uuid, userId: userIdPersonal(), workspaceId: args.workspaceId, projectId: args.projectId, kind: "note", status: "open", title: args.title?.trim() || undefined, content: args.content, createdAt: now, updatedAt: now });
    await addEvent(ctx, { workspaceId: args.workspaceId, projectId: args.projectId, actor: { kind: "agent", id: agent._id }, eventType: "note_created", entityType: "note", entityId: uuid, summary: `Creó la nota ${args.title?.trim() || "sin título"}` });
    const note = await ctx.db.get(id); if (!note) throw new Error("No se pudo crear la nota.");
    return publicAgentNote(note);
  },
});

export const actualizarNotaAgente = internalMutation({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents"), id: v.string(), title: v.optional(v.union(v.string(), v.null())), content: v.optional(v.string()), status: v.optional(v.union(v.literal("open"), v.literal("attended"))), projectId: v.optional(v.union(v.id("projects"), v.null())) },
  returns: agentNoteValidator,
  handler: async (ctx, args) => {
    const agent = await ensureAgent(ctx, args.workspaceId, args.agentId);
    const note = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", args.id)).unique();
    if (!note || note.workspaceId !== args.workspaceId || note.deletedAt !== undefined) throw new Error("La nota no pertenece a este espacio.");
    if (args.title && args.title.length > 300) throw new Error("El título supera 300 caracteres.");
    if (args.content !== undefined && args.content.length > 500_000) throw new Error("La nota supera 500.000 caracteres.");
    if (args.projectId) await ensureProject(ctx, args.workspaceId, args.projectId);
    const patch: { title?: string; content?: string; status?: "open" | "attended"; projectId?: Id<"projects">; updatedAt: number } = { updatedAt: Date.now() };
    if (args.title !== undefined) patch.title = args.title?.trim() || undefined;
    if (args.content !== undefined) patch.content = args.content;
    if (args.status !== undefined) patch.status = args.status;
    if (args.projectId !== undefined) patch.projectId = args.projectId ?? undefined;
    await ctx.db.patch(note._id, patch);
    await addEvent(ctx, { workspaceId: args.workspaceId, projectId: args.projectId ?? note.projectId, actor: { kind: "agent", id: agent._id }, eventType: "note_updated", entityType: "note", entityId: args.id, summary: `Actualizó la nota ${args.title ?? note.title ?? "sin título"}` });
    const updated = await ctx.db.get(note._id); if (!updated) throw new Error("No se pudo actualizar la nota.");
    return publicAgentNote(updated);
  },
});

export const borrarNotaAgente = internalMutation({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents"), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agent = await ensureAgent(ctx, args.workspaceId, args.agentId);
    const note = await ctx.db.query("notes").withIndex("by_uuid", q => q.eq("uuid", args.id)).unique();
    if (!note) return false;
    if (note.workspaceId !== args.workspaceId) throw new Error("La nota no pertenece a este espacio.");
    if (note.deletedAt !== undefined) return true;
    for await (const link of ctx.db.query("noteLinks").withIndex("by_sourceNoteId_and_targetNoteId", q => q.eq("sourceNoteId", args.id))) await ctx.db.delete("noteLinks", link._id);
    for await (const link of ctx.db.query("noteLinks").withIndex("by_targetNoteId", q => q.eq("targetNoteId", args.id))) await ctx.db.delete("noteLinks", link._id);
    for await (const image of ctx.db.query("noteImages").withIndex("by_noteId_and_createdAt", q => q.eq("noteId", args.id))) {
      await ctx.storage.delete(image.storageId);
      await ctx.db.delete("noteImages", image._id);
    }
    const now = Date.now();
    await ctx.db.patch("notes", note._id, { title: undefined, content: "", projectId: undefined, deletedAt: now, updatedAt: now });
    await addEvent(ctx, { workspaceId: args.workspaceId, projectId: note.projectId, actor: { kind: "agent", id: agent._id }, eventType: "note_deleted", entityType: "note", entityId: args.id, summary: `Eliminó la nota ${note.title ?? "sin título"}` });
    return true;
  },
});

export const comentariosAgente = internalQuery({
  args: { workspaceId: v.id("workspaces"), taskId: v.id("tasks") }, returns: v.array(commentValidator),
  handler: async (ctx, { workspaceId, taskId }) => {
    const task = await ctx.db.get(taskId); if (!task || task.workspaceId !== workspaceId) throw new Error("La tarea no pertenece a este espacio.");
    const docs = await ctx.db.query("taskComments").withIndex("by_taskId_and_createdAt", (q) => q.eq("taskId", taskId)).order("asc").take(500);
    return docs.map(publicComment);
  },
});

export const agregarComentarioAgente = internalMutation({
  args: { workspaceId: v.id("workspaces"), agentId: v.id("agents"), taskId: v.id("tasks"), kind: commentKind, content: v.string() }, returns: commentValidator,
  handler: async (ctx, { workspaceId, agentId, taskId, kind, content }) => {
    const agent = await ensureAgent(ctx, workspaceId, agentId);
    return addComment(ctx, workspaceId, { kind: "agent", id: agent._id }, taskId, kind, content);
  },
});

export const actividadAgente = internalQuery({
  args: { workspaceId: v.id("workspaces"), since: v.optional(v.number()) }, returns: v.array(eventValidator),
  handler: async (ctx, { workspaceId, since }) => listEvents(ctx, workspaceId, since),
});

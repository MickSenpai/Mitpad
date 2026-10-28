import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import { exigirToken, userIdPersonal } from "./acceso";
import { asegurarWorkspace } from "./workspaces";

const status = v.union(v.literal("active"), v.literal("archived"));
const taskStatus = v.union(v.literal("backlog"), v.literal("todo"), v.literal("in_progress"), v.literal("review"), v.literal("blocked"), v.literal("done"));
const priority = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"));
const kind = v.union(v.literal("message"), v.literal("instruction"), v.literal("question"), v.literal("answer"), v.literal("decision"), v.literal("update"));

const projectResult = v.object({ id: v.id("projects"), clientId: v.union(v.string(), v.null()), name: v.string(), description: v.string(), status, createdAt: v.number(), updatedAt: v.number() });
const taskResult = v.object({
  id: v.id("tasks"), clientId: v.union(v.string(), v.null()), projectId: v.id("projects"), title: v.string(), description: v.string(),
  status: taskStatus, priority, dueAt: v.union(v.number(), v.null()), assigneeAgentId: v.union(v.id("agents"), v.null()), createdAt: v.number(), updatedAt: v.number(),
});
const commentResult = v.object({
  id: v.id("taskComments"), clientId: v.union(v.string(), v.null()), taskId: v.id("tasks"), projectId: v.id("projects"),
  authorType: v.union(v.literal("human"), v.literal("agent")), authorId: v.string(), kind, content: v.string(), createdAt: v.number(),
});

const publicProject = (doc: Doc<"projects">) => ({ id: doc._id, clientId: doc.clientId ?? null, name: doc.name, description: doc.description, status: doc.status, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
const publicTask = (doc: Doc<"tasks">) => ({ id: doc._id, clientId: doc.clientId ?? null, projectId: doc.projectId, title: doc.title, description: doc.description, status: doc.status, priority: doc.priority, dueAt: doc.dueAt ?? null, assigneeAgentId: doc.assigneeAgentId ?? null, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
const publicComment = (doc: Doc<"taskComments">) => ({ id: doc._id, clientId: doc.clientId ?? null, taskId: doc.taskId, projectId: doc.projectId, authorType: doc.authorType, authorId: doc.authorId, kind: doc.kind, content: doc.content, createdAt: doc.createdAt });

function validarClientId(id: string) {
  if (!id.trim() || id.length > 100) throw new ConvexError("clientId inválido.");
}

/** Idempotent local-first project write. Retries reuse the same clientId. */
export const proyecto = mutation({
  args: { token: v.string(), clientId: v.string(), name: v.string(), description: v.string(), status, createdAt: v.number(), updatedAt: v.number() },
  returns: projectResult,
  handler: async (ctx, args) => {
    exigirToken(args.token);
    validarClientId(args.clientId);
    if (!args.name.trim() || args.name.length > 160 || args.description.length > 20_000) throw new ConvexError("Datos de proyecto inválidos.");
    const workspaceId = await asegurarWorkspace(ctx, userIdPersonal());
    const existing = await ctx.db.query("projects").withIndex("by_workspaceId_and_clientId", (q) => q.eq("workspaceId", workspaceId).eq("clientId", args.clientId)).unique();
    if (existing) {
      if (args.updatedAt > existing.updatedAt) await ctx.db.patch(existing._id, { name: args.name.trim(), description: args.description, status: args.status, updatedAt: args.updatedAt });
      const current = await ctx.db.get(existing._id);
      if (!current) throw new ConvexError("No se pudo recuperar el proyecto sincronizado.");
      return publicProject(current);
    }
    const id = await ctx.db.insert("projects", {
      workspaceId, clientId: args.clientId, name: args.name.trim(), description: args.description, status: args.status,
      createdByType: "human", createdById: "pilot", createdAt: args.createdAt, updatedAt: args.updatedAt,
    });
    await ctx.db.insert("activityEvents", { workspaceId, projectId: id, actorType: "human", actorId: "pilot", eventType: "project_created", entityType: "project", entityId: id, summary: `Creó el proyecto ${args.name.trim()}`, createdAt: Date.now() });
    const project = await ctx.db.get(id);
    if (!project) throw new ConvexError("No se pudo crear el proyecto.");
    return publicProject(project);
  },
});

/** Idempotent local-first task write; taskId adopts a record pulled from cloud. */
export const tarea = mutation({
  args: {
    token: v.string(), clientId: v.string(), taskId: v.optional(v.id("tasks")), projectId: v.id("projects"),
    title: v.string(), description: v.string(), status: taskStatus, priority, dueAt: v.union(v.number(), v.null()),
    assigneeAgentId: v.union(v.id("agents"), v.null()), createdAt: v.number(), updatedAt: v.number(),
  },
  returns: taskResult,
  handler: async (ctx, args) => {
    exigirToken(args.token);
    validarClientId(args.clientId);
    if (!args.title.trim() || args.title.length > 240 || args.description.length > 50_000) throw new ConvexError("Datos de tarea inválidos.");
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal())).unique();
    if (!workspace) throw new ConvexError("No existe el espacio personal.");
    const project = await ctx.db.get(args.projectId);
    if (!project || project.workspaceId !== workspace._id) throw new ConvexError("El proyecto no pertenece a este espacio.");
    if (args.assigneeAgentId) {
      const agent = await ctx.db.get(args.assigneeAgentId);
      if (!agent || agent.workspaceId !== workspace._id || !agent.active) throw new ConvexError("El agente asignado no pertenece a este espacio.");
    }
    let existing = args.taskId ? await ctx.db.get(args.taskId) : null;
    if (existing && existing.workspaceId !== workspace._id) throw new ConvexError("La tarea no pertenece a este espacio.");
    if (!existing) existing = await ctx.db.query("tasks").withIndex("by_workspaceId_and_clientId", (q) => q.eq("workspaceId", workspace._id).eq("clientId", args.clientId)).unique();
    if (existing) {
      const changed = existing.projectId !== args.projectId || existing.title !== args.title.trim() || existing.description !== args.description || existing.status !== args.status || existing.priority !== args.priority || existing.dueAt !== (args.dueAt ?? undefined) || existing.assigneeAgentId !== (args.assigneeAgentId ?? undefined);
      if (changed) await ctx.db.patch(existing._id, {
        clientId: args.clientId, projectId: args.projectId, title: args.title.trim(), description: args.description,
        status: args.status, priority: args.priority, dueAt: args.dueAt ?? undefined,
        assigneeAgentId: args.assigneeAgentId ?? undefined, updatedAt: Math.max(args.updatedAt, existing.updatedAt),
      });
      const current = await ctx.db.get(existing._id);
      if (!current) throw new ConvexError("No se pudo recuperar la tarea sincronizada.");
      if (changed) await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: current.projectId, actorType: "human", actorId: "pilot", eventType: "task_updated", entityType: "task", entityId: current._id, summary: `Actualizó la tarea ${current.title}`, createdAt: Date.now() });
      return publicTask(current);
    }
    const id = await ctx.db.insert("tasks", {
      workspaceId: workspace._id, clientId: args.clientId, projectId: args.projectId, title: args.title.trim(), description: args.description,
      status: args.status, priority: args.priority, dueAt: args.dueAt ?? undefined, assigneeAgentId: args.assigneeAgentId ?? undefined,
      createdByType: "human", createdById: "pilot", createdAt: args.createdAt, updatedAt: args.updatedAt,
    });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: args.projectId, actorType: "human", actorId: "pilot", eventType: "task_created", entityType: "task", entityId: id, summary: `Creó la tarea ${args.title.trim()}`, createdAt: Date.now() });
    const task = await ctx.db.get(id);
    if (!task) throw new ConvexError("No se pudo crear la tarea.");
    return publicTask(task);
  },
});

/** Idempotent local-first comment write. */
export const comentario = mutation({
  args: { token: v.string(), clientId: v.string(), taskId: v.id("tasks"), kind, content: v.string(), createdAt: v.number() },
  returns: commentResult,
  handler: async (ctx, args) => {
    exigirToken(args.token);
    validarClientId(args.clientId);
    if (!args.content.trim() || args.content.length > 20_000) throw new ConvexError("Comentario inválido.");
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal())).unique();
    if (!workspace) throw new ConvexError("No existe el espacio personal.");
    const task = await ctx.db.get(args.taskId);
    if (!task || task.workspaceId !== workspace._id) throw new ConvexError("La tarea no pertenece a este espacio.");
    const existing = await ctx.db.query("taskComments").withIndex("by_workspaceId_and_clientId", (q) => q.eq("workspaceId", workspace._id).eq("clientId", args.clientId)).unique();
    if (existing) return publicComment(existing);
    const id = await ctx.db.insert("taskComments", { workspaceId: workspace._id, clientId: args.clientId, projectId: task.projectId, taskId: task._id, authorType: "human", authorId: "pilot", kind: args.kind, content: args.content.trim(), createdAt: args.createdAt });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: task.projectId, actorType: "human", actorId: "pilot", eventType: "comment_created", entityType: "comment", entityId: id, summary: `Comentó en ${task.title}`, details: args.content.trim(), createdAt: Date.now() });
    const comment = await ctx.db.get(id);
    if (!comment) throw new ConvexError("No se pudo crear el comentario.");
    return publicComment(comment);
  },
});

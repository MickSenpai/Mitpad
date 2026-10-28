import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { userIdPersonal } from "./acceso";
import { exigirWeb } from "./webAuth";

const status = v.union(v.literal("backlog"), v.literal("todo"), v.literal("in_progress"), v.literal("review"), v.literal("done"), v.literal("blocked"));
const project = v.object({ id: v.id("projects"), name: v.string(), description: v.string(), status: v.union(v.literal("active"), v.literal("archived")) });
const task = v.object({ id: v.id("tasks"), projectId: v.id("projects"), title: v.string(), description: v.string(), status, priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")), assigneeAgentId: v.union(v.id("agents"), v.null()), createdByType: v.union(v.literal("human"), v.literal("agent")), createdById: v.string(), updatedAt: v.number() });
const note = v.object({ id: v.string(), title: v.union(v.string(), v.null()), content: v.string(), status: v.union(v.literal("open"), v.literal("attended")), projectId: v.union(v.id("projects"), v.null()), updatedAt: v.number() });
const image = v.object({ id: v.id("noteImages"), projectId: v.union(v.id("projects"), v.null()), noteId: v.union(v.string(), v.null()), filename: v.string(), contentType: v.string(), size: v.number(), url: v.union(v.string(), v.null()), createdAt: v.number() });
export const dashboard = query({
  args: {},
  returns: v.object({ projects: v.array(project), tasks: v.array(task), agents: v.array(v.object({ id: v.id("agents"), name: v.string(), model: v.string(), clientType: v.string(), active: v.boolean(), lastSeenAt: v.union(v.number(), v.null()) })), events: v.array(v.object({ id: v.id("activityEvents"), summary: v.string(), actorType: v.union(v.literal("human"), v.literal("agent")), actorId: v.string(), createdAt: v.number() })), notes: v.array(note), images: v.array(image) }),
  handler: async (ctx) => {
    const { workspace } = await exigirWeb(ctx);
    const [projects, tasks, agents, events, notes, images] = await Promise.all([
      ctx.db.query("projects").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(300),
      ctx.db.query("tasks").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(500),
      ctx.db.query("agents").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(200),
      ctx.db.query("activityEvents").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(100),
      ctx.db.query("notes").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(200),
      ctx.db.query("noteImages").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(200),
    ]);
    return {
      projects: projects.map(p => ({ id: p._id, name: p.name, description: p.description, status: p.status })),
      tasks: tasks.map(t => ({ id: t._id, projectId: t.projectId, title: t.title, description: t.description, status: t.status, priority: t.priority, assigneeAgentId: t.assigneeAgentId ?? null, createdByType: t.createdByType, createdById: t.createdById, updatedAt: t.updatedAt })),
      agents: agents.map(a => ({ id: a._id, name: a.name, model: a.model, clientType: a.clientType, active: a.active, lastSeenAt: a.lastSeenAt ?? null })),
      events: events.map(e => ({ id: e._id, summary: e.summary, actorType: e.actorType, actorId: e.actorId, createdAt: e.createdAt })),
      notes: notes.map(n => ({ id: n.uuid, title: n.title ?? null, content: n.content, status: n.status ?? "open" as const, projectId: n.projectId ?? null, updatedAt: n.updatedAt })),
      images: await Promise.all(images.map(async (i) => ({ id: i._id, projectId: i.projectId ?? null, noteId: i.noteId ?? null, filename: i.filename, contentType: i.contentType, size: i.size, url: await ctx.storage.getUrl(i.storageId), createdAt: i.createdAt }))),
    };
  },
});

export const crearProyecto = mutation({
  args: { name: v.string(), description: v.optional(v.string()) }, returns: project,
  handler: async (ctx, args) => {
    const { workspace, identity } = await exigirWeb(ctx);
    if (!args.name.trim() || args.name.length > 120 || (args.description?.length ?? 0) > 20000) throw new ConvexError("Revisa el nombre y la descripción del proyecto.");
    const now = Date.now();
    const id = await ctx.db.insert("projects", { workspaceId: workspace._id, name: args.name.trim(), description: args.description?.trim() ?? "", status: "active", createdByType: "human", createdById: identity.tokenIdentifier, createdAt: now, updatedAt: now });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: id, actorType: "human", actorId: identity.tokenIdentifier, eventType: "project_created", entityType: "project", entityId: id, summary: `Creó el proyecto ${args.name.trim()}`, createdAt: now });
    return { id, name: args.name.trim(), description: args.description?.trim() ?? "", status: "active" as const };
  },
});

export const crearTarea = mutation({
  args: { projectId: v.id("projects"), title: v.string(), description: v.optional(v.string()), priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))) }, returns: task,
  handler: async (ctx, args) => {
    const { workspace, identity } = await exigirWeb(ctx);
    const projectDoc = await ctx.db.get(args.projectId);
    if (!projectDoc || projectDoc.workspaceId !== workspace._id) throw new ConvexError("El proyecto no pertenece al workspace.");
    if (!args.title.trim() || args.title.length > 200 || (args.description?.length ?? 0) > 50000) throw new ConvexError("Revisa el título y la descripción de la tarea.");
    const now = Date.now();
    const id = await ctx.db.insert("tasks", { workspaceId: workspace._id, projectId: args.projectId, title: args.title.trim(), description: args.description?.trim() ?? "", status: "todo", priority: args.priority ?? "medium", createdByType: "human", createdById: identity.tokenIdentifier, createdAt: now, updatedAt: now });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: args.projectId, actorType: "human", actorId: identity.tokenIdentifier, eventType: "task_created", entityType: "task", entityId: id, summary: `Creó la tarea ${args.title.trim()}`, createdAt: now });
    return { id, projectId: args.projectId, title: args.title.trim(), description: args.description?.trim() ?? "", status: "todo" as const, priority: args.priority ?? "medium", assigneeAgentId: null, createdByType: "human" as const, createdById: identity.tokenIdentifier, updatedAt: now };
  },
});

export const actualizarTarea = mutation({
  args: { taskId: v.id("tasks"), status }, returns: v.null(),
  handler: async (ctx, { taskId, status: nextStatus }) => {
    const { workspace, identity } = await exigirWeb(ctx);
    const current = await ctx.db.get(taskId);
    if (!current || current.workspaceId !== workspace._id) throw new ConvexError("La tarea no pertenece al workspace.");
    const now = Date.now(); await ctx.db.patch(taskId, { status: nextStatus, updatedAt: now });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: current.projectId, actorType: "human", actorId: identity.tokenIdentifier, eventType: "task_updated", entityType: "task", entityId: taskId, summary: `Movió ${current.title} a ${nextStatus}`, createdAt: now });
    return null;
  },
});

export const guardarNota = mutation({
  args: { id: v.optional(v.string()), title: v.string(), content: v.string(), projectId: v.optional(v.union(v.id("projects"), v.null())), status: v.optional(v.union(v.literal("open"), v.literal("attended"))) }, returns: v.string(),
  handler: async (ctx, args) => {
    const { workspace, identity } = await exigirWeb(ctx);
    if (args.title.length > 300 || args.content.length > 500000) throw new ConvexError("La nota supera el límite permitido.");
    if (args.projectId) { const p = await ctx.db.get(args.projectId); if (!p || p.workspaceId !== workspace._id) throw new ConvexError("El proyecto no pertenece al workspace."); }
    const now = Date.now(); const existing = args.id ? await ctx.db.query("notes").withIndex("by_uuid", q => q.eq("uuid", args.id!)).unique() : null;
    if (existing && existing.workspaceId !== workspace._id) throw new ConvexError("La nota no pertenece al workspace.");
    const noteId = args.id ?? crypto.randomUUID();
    if (existing) await ctx.db.patch(existing._id, { title: args.title.trim() || undefined, content: args.content, projectId: args.projectId ?? undefined, status: args.status ?? existing.status ?? "open", updatedAt: now });
    else await ctx.db.insert("notes", { uuid: noteId, userId: userIdPersonal(), workspaceId: workspace._id, projectId: args.projectId ?? undefined, kind: "note", title: args.title.trim() || undefined, content: args.content, status: args.status ?? "open", createdAt: now, updatedAt: now });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: args.projectId ?? undefined, actorType: "human", actorId: identity.tokenIdentifier, eventType: existing ? "note_updated" : "note_created", entityType: "note", entityId: noteId, summary: `${existing ? "Actualizó" : "Creó"} la nota ${args.title.trim() || "sin título"}`, createdAt: now });
    return noteId;
  },
});

export const crearUrlSubidaImagen = mutation({
  args: { projectId: v.id("projects") }, returns: v.string(),
  handler: async (ctx, { projectId }) => {
    const { workspace } = await exigirWeb(ctx); const projectDoc = await ctx.db.get(projectId);
    if (!projectDoc || projectDoc.workspaceId !== workspace._id) throw new ConvexError("El proyecto no pertenece al workspace.");
    return await ctx.storage.generateUploadUrl();
  },
});

export const registrarImagen = mutation({
  args: { projectId: v.id("projects"), storageId: v.id("_storage"), filename: v.string() }, returns: v.id("noteImages"),
  handler: async (ctx, args) => {
    const { workspace } = await exigirWeb(ctx); const p = await ctx.db.get(args.projectId);
    if (!p || p.workspaceId !== workspace._id) throw new ConvexError("El proyecto no pertenece al workspace.");
    const meta = await ctx.db.system.get("_storage", args.storageId);
    if (!meta || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(meta.contentType ?? "") || meta.size > 10 * 1024 * 1024) throw new ConvexError("Imagen inválida: usa JPEG, PNG, WebP o GIF de hasta 10 MB.");
    const existing = await ctx.db.query("noteImages").withIndex("by_projectId_and_createdAt", q => q.eq("projectId", args.projectId)).take(200);
    if (existing.length >= 200 || existing.reduce((sum, img) => sum + img.size, 0) + meta.size > 50 * 1024 * 1024) throw new ConvexError("Se alcanzó el límite de imágenes del proyecto.");
    return await ctx.db.insert("noteImages", { workspaceId: workspace._id, projectId: args.projectId, storageId: args.storageId, filename: args.filename.trim().slice(0, 255), contentType: meta.contentType!, size: meta.size, createdAt: Date.now() });
  },
});

export const borrarImagen = mutation({
  args: { imageId: v.id("noteImages") }, returns: v.boolean(),
  handler: async (ctx, { imageId }) => { const { workspace } = await exigirWeb(ctx); const imageDoc = await ctx.db.get(imageId); if (!imageDoc || imageDoc.workspaceId !== workspace._id) return false; await ctx.storage.delete(imageDoc.storageId); await ctx.db.delete(imageId); return true; },
});

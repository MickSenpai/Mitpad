import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { exigirWeb } from "./webAuth";
import { userIdPersonal } from "./acceso";

const relationType = v.union(v.literal("related_to"), v.literal("parent_of"), v.literal("depends_on"));
const taskStatus = v.union(v.literal("backlog"), v.literal("todo"), v.literal("in_progress"), v.literal("review"), v.literal("done"), v.literal("blocked"));
const priority = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"));

async function workspace(ctx: Parameters<typeof exigirWeb>[0]) {
  return await exigirWeb(ctx);
}

export const snapshot = query({
  args: {},
  returns: v.object({
    projects: v.array(v.object({ id: v.id("projects"), clientId: v.union(v.string(), v.null()), name: v.string(), description: v.string(), status: v.union(v.literal("active"), v.literal("archived")), createdAt: v.number(), updatedAt: v.number() })),
    agents: v.array(v.object({ id: v.id("agents"), name: v.string(), model: v.string(), modelProvider: v.string(), clientType: v.string(), active: v.boolean(), createdAt: v.number(), lastSeenAt: v.union(v.number(), v.null()) })),
    tasks: v.array(v.object({ id: v.id("tasks"), clientId: v.union(v.string(), v.null()), projectId: v.id("projects"), title: v.string(), description: v.string(), status: taskStatus, priority, assigneeAgentId: v.union(v.id("agents"), v.null()), dueAt: v.union(v.number(), v.null()), createdAt: v.number(), updatedAt: v.number() })),
    comments: v.array(v.object({ id: v.id("taskComments"), clientId: v.union(v.string(), v.null()), projectId: v.id("projects"), taskId: v.id("tasks"), authorType: v.union(v.literal("human"), v.literal("agent")), authorId: v.string(), kind: v.union(v.literal("message"), v.literal("instruction"), v.literal("question"), v.literal("answer"), v.literal("decision"), v.literal("update")), content: v.string(), createdAt: v.number() })),
    links: v.array(v.object({ id: v.id("projectLinks"), clientId: v.union(v.string(), v.null()), sourceProjectId: v.id("projects"), targetProjectId: v.id("projects"), relationType, description: v.string(), createdAt: v.number() })),
    notes: v.array(v.object({ uuid: v.string(), title: v.union(v.string(), v.null()), content: v.string(), status: v.union(v.literal("open"), v.literal("attended")), createdAt: v.number(), updatedAt: v.number() })),
    knowledge: v.array(v.object({ id: v.id("projectKnowledge"), projectId: v.id("projects"), kind: v.union(v.literal("module"), v.literal("function"), v.literal("data"), v.literal("capability"), v.literal("integration"), v.literal("decision")), title: v.string(), summary: v.string(), source: v.string(), tags: v.array(v.string()), updatedAt: v.number() })),
    images: v.array(v.object({ id: v.id("noteImages"), localId: v.union(v.string(), v.null()), noteId: v.union(v.string(), v.null()), projectId: v.union(v.id("projects"), v.null()), filename: v.string(), contentType: v.string(), size: v.number(), createdAt: v.number(), url: v.union(v.string(), v.null()) })),
  }),
  handler: async (ctx) => {
    const { workspace: ws } = await workspace(ctx);
    const [projects, agents, tasks, comments, links, notes, knowledge, images] = await Promise.all([
      ctx.db.query("projects").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", ws._id)).order("desc").take(500),
      ctx.db.query("agents").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", ws._id)).order("desc").take(500),
      ctx.db.query("tasks").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", ws._id)).order("desc").take(1000),
      ctx.db.query("taskComments").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", ws._id)).order("desc").take(1000),
      ctx.db.query("projectLinks").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", ws._id)).order("desc").take(1000),
      ctx.db.query("notes").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", ws._id)).order("desc").take(500),
      ctx.db.query("projectKnowledge").withIndex("by_workspaceId_and_projectId", q => q.eq("workspaceId", ws._id)).take(1000),
      ctx.db.query("noteImages").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", ws._id)).order("desc").take(500),
    ]);
    return {
      projects: projects.map(p => ({ id: p._id, clientId: p.clientId ?? null, name: p.name, description: p.description, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt })),
      agents: agents.map(a => ({ id: a._id, name: a.name, model: a.model, modelProvider: a.modelProvider, clientType: a.clientType, active: a.active, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt ?? null })),
      tasks: tasks.map(t => ({ id: t._id, clientId: t.clientId ?? null, projectId: t.projectId, title: t.title, description: t.description, status: t.status, priority: t.priority, assigneeAgentId: t.assigneeAgentId ?? null, dueAt: t.dueAt ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt })),
      comments: comments.map(c => ({ id: c._id, clientId: c.clientId ?? null, projectId: c.projectId, taskId: c.taskId, authorType: c.authorType, authorId: c.authorId, kind: c.kind, content: c.content, createdAt: c.createdAt })),
      links: links.map(l => ({ id: l._id, clientId: l.clientId ?? null, sourceProjectId: l.sourceProjectId, targetProjectId: l.targetProjectId, relationType: l.relationType, description: l.description ?? "", createdAt: l.createdAt })),
      notes: notes.map(n => ({ uuid: n.uuid, title: n.title ?? null, content: n.content, status: n.status ?? "open" as const, createdAt: n.createdAt, updatedAt: n.updatedAt })),
      knowledge: knowledge.map(k => ({ id: k._id, projectId: k.projectId, kind: k.kind, title: k.title, summary: k.summary, source: k.source, tags: k.tags, updatedAt: k.updatedAt })),
      images: await Promise.all(images.map(async image => ({ id: image._id, localId: image.localId ?? null, noteId: image.noteId ?? null, projectId: image.projectId ?? null, filename: image.filename, contentType: image.contentType, size: image.size, createdAt: image.createdAt, url: await ctx.storage.getUrl(image.storageId) }))),
    };
  },
});

export const createImageUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await workspace(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const registerImage = mutation({
  args: { localId: v.string(), noteId: v.union(v.string(), v.null()), projectId: v.union(v.id("projects"), v.null()), storageId: v.id("_storage"), filename: v.string(), contentType: v.string(), size: v.number(), createdAt: v.number() },
  returns: v.id("noteImages"),
  handler: async (ctx, args) => {
    const { workspace: ws } = await workspace(ctx);
    if (!args.noteId && !args.projectId) throw new ConvexError("La imagen debe pertenecer a una nota o proyecto.");
    if (args.noteId) {
      const note = await ctx.db.query("notes").withIndex("by_uuid", q => q.eq("uuid", args.noteId!)).unique();
      if (!note || note.workspaceId !== ws._id) throw new ConvexError("La nota no pertenece al workspace.");
    }
    if (args.projectId) {
      const project = await ctx.db.get(args.projectId);
      if (!project || project.workspaceId !== ws._id) throw new ConvexError("El proyecto no pertenece al workspace.");
    }
    if (!/^(image\/(jpeg|png|webp|gif))$/.test(args.contentType) || args.size < 1 || args.size > 10 * 1024 * 1024 || args.filename.trim().length < 1 || args.filename.length > 255) throw new ConvexError("La imagen no cumple los límites permitidos.");
    const stored = await ctx.db.system.get(args.storageId);
    if (!stored || stored.size !== args.size || stored.contentType !== args.contentType) throw new ConvexError("El archivo subido no coincide con sus metadatos.");
    const existing = await ctx.db.query("noteImages").withIndex("by_workspaceId_and_localId", q => q.eq("workspaceId", ws._id).eq("localId", args.localId)).unique();
    if (existing) {
      if (existing.storageId !== args.storageId) await ctx.storage.delete(args.storageId);
      return existing._id;
    }
    const siblings = args.noteId
      ? await ctx.db.query("noteImages").withIndex("by_noteId_and_createdAt", q => q.eq("noteId", args.noteId!)).take(201)
      : await ctx.db.query("noteImages").withIndex("by_projectId_and_createdAt", q => q.eq("projectId", args.projectId!)).take(201);
    if (siblings.length >= 200 || siblings.reduce((total, image) => total + image.size, 0) + args.size > 50 * 1024 * 1024) {
      await ctx.storage.delete(args.storageId);
      throw new ConvexError("Se alcanzó el límite de imágenes del proyecto o nota.");
    }
    return await ctx.db.insert("noteImages", { workspaceId: ws._id, localId: args.localId, noteId: args.noteId ?? undefined, projectId: args.projectId ?? undefined, storageId: args.storageId, filename: args.filename.trim(), contentType: args.contentType, size: args.size, createdAt: args.createdAt });
  },
});

export const upsertProject = mutation({
  args: { clientId: v.string(), projectId: v.union(v.id("projects"), v.null()), name: v.string(), description: v.string(), status: v.union(v.literal("active"), v.literal("archived")), createdAt: v.number(), updatedAt: v.number() },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const { workspace: ws, identity } = await workspace(ctx);
    let current: Doc<"projects"> | null = args.projectId ? await ctx.db.get(args.projectId) : null;
    if (current && current.workspaceId !== ws._id) throw new ConvexError("El proyecto no pertenece al workspace.");
    current ??= await ctx.db.query("projects").withIndex("by_workspaceId_and_clientId", q => q.eq("workspaceId", ws._id).eq("clientId", args.clientId)).unique();
    if (current) {
      if (args.updatedAt >= current.updatedAt) {
        await ctx.db.patch(current._id, { clientId: args.clientId, name: args.name, description: args.description, status: args.status, updatedAt: args.updatedAt });
      }
      return current._id;
    }
    return await ctx.db.insert("projects", { workspaceId: ws._id, clientId: args.clientId, name: args.name, description: args.description, status: args.status, createdByType: "human", createdById: identity.tokenIdentifier, createdAt: args.createdAt, updatedAt: args.updatedAt });
  },
});

export const upsertTask = mutation({
  args: { clientId: v.string(), taskId: v.union(v.id("tasks"), v.null()), projectId: v.id("projects"), assigneeAgentId: v.union(v.id("agents"), v.null()), title: v.string(), description: v.string(), status: taskStatus, priority, dueAt: v.union(v.number(), v.null()), createdAt: v.number(), updatedAt: v.number() },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const { workspace: ws, identity } = await workspace(ctx);
    const parent = await ctx.db.get(args.projectId);
    if (!parent || parent.workspaceId !== ws._id) throw new ConvexError("El proyecto no pertenece al workspace.");
    let current: Doc<"tasks"> | null = args.taskId ? await ctx.db.get(args.taskId) : null;
    if (current && current.workspaceId !== ws._id) throw new ConvexError("La tarea no pertenece al workspace.");
    current ??= await ctx.db.query("tasks").withIndex("by_workspaceId_and_clientId", q => q.eq("workspaceId", ws._id).eq("clientId", args.clientId)).unique();
    const fields = { clientId: args.clientId, projectId: args.projectId, assigneeAgentId: args.assigneeAgentId ?? undefined, title: args.title, description: args.description, status: args.status, priority: args.priority, dueAt: args.dueAt ?? undefined, updatedAt: Math.max(args.updatedAt, current?.updatedAt ?? 0) };
    if (current) {
      if (args.updatedAt >= current.updatedAt) await ctx.db.patch(current._id, fields);
      return current._id;
    }
    return await ctx.db.insert("tasks", { workspaceId: ws._id, ...fields, createdByType: "human", createdById: identity.tokenIdentifier, createdAt: args.createdAt });
  },
});

export const upsertComment = mutation({
  args: { clientId: v.string(), taskId: v.id("tasks"), kind: v.union(v.literal("message"), v.literal("instruction"), v.literal("question"), v.literal("answer"), v.literal("decision"), v.literal("update")), content: v.string(), createdAt: v.number() },
  returns: v.id("taskComments"),
  handler: async (ctx, args) => {
    const { workspace: ws, identity } = await workspace(ctx);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.workspaceId !== ws._id) throw new ConvexError("La tarea no pertenece al workspace.");
    const existing = await ctx.db.query("taskComments").withIndex("by_workspaceId_and_clientId", q => q.eq("workspaceId", ws._id).eq("clientId", args.clientId)).unique();
    if (existing) return existing._id;
    return await ctx.db.insert("taskComments", { workspaceId: ws._id, clientId: args.clientId, projectId: task.projectId, taskId: args.taskId, authorType: "human", authorId: identity.tokenIdentifier, kind: args.kind, content: args.content, createdAt: args.createdAt });
  },
});

export const upsertNote = mutation({
  args: { uuid: v.string(), title: v.union(v.string(), v.null()), content: v.string(), status: v.union(v.literal("open"), v.literal("attended")), createdAt: v.number(), updatedAt: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const { workspace: ws } = await workspace(ctx);
    const current = await ctx.db.query("notes").withIndex("by_uuid", q => q.eq("uuid", args.uuid)).unique();
    if (current && current.workspaceId !== ws._id) throw new ConvexError("La nota no pertenece al workspace.");
    if (current) {
      if (args.updatedAt >= current.updatedAt) await ctx.db.patch(current._id, { title: args.title ?? undefined, content: args.content, status: args.status, updatedAt: args.updatedAt });
      return args.uuid;
    }
    await ctx.db.insert("notes", { uuid: args.uuid, userId: userIdPersonal(), workspaceId: ws._id, kind: "note", title: args.title ?? undefined, content: args.content, status: args.status, createdAt: args.createdAt, updatedAt: args.updatedAt });
    return args.uuid;
  },
});

export const upsertLink = mutation({
  args: { clientId: v.string(), sourceProjectId: v.id("projects"), targetProjectId: v.id("projects"), relationType, description: v.string(), createdAt: v.number() },
  returns: v.id("projectLinks"),
  handler: async (ctx, args) => {
    const { workspace: ws } = await workspace(ctx);
    const [source, target] = await Promise.all([ctx.db.get(args.sourceProjectId), ctx.db.get(args.targetProjectId)]);
    if (!source || !target || source.workspaceId !== ws._id || target.workspaceId !== ws._id || source._id === target._id) throw new ConvexError("La relación requiere dos proyectos del workspace.");
    const old = await ctx.db.query("projectLinks").withIndex("by_workspaceId_and_clientId", q => q.eq("workspaceId", ws._id).eq("clientId", args.clientId)).unique();
    if (old) { await ctx.db.patch(old._id, { sourceProjectId: args.sourceProjectId, targetProjectId: args.targetProjectId, relationType: args.relationType, description: args.description }); return old._id; }
    return await ctx.db.insert("projectLinks", { workspaceId: ws._id, clientId: args.clientId, sourceProjectId: args.sourceProjectId, targetProjectId: args.targetProjectId, relationType: args.relationType, description: args.description, createdAt: args.createdAt });
  },
});

export const deleteLink = mutation({
  args: { id: v.id("projectLinks") }, returns: v.null(),
  handler: async (ctx, { id }) => { const { workspace: ws } = await workspace(ctx); const link = await ctx.db.get(id); if (link?.workspaceId === ws._id) await ctx.db.delete(id); return null; },
});

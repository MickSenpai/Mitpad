import { ConvexError, v } from "convex/values";
import { env, mutation, query } from "./_generated/server";
import { hashAgentApiKey, userIdPersonal } from "./acceso";
import { getAuthUserId } from "@convex-dev/auth/server";
import { exigirWeb } from "./webAuth";

const status = v.union(v.literal("backlog"), v.literal("todo"), v.literal("in_progress"), v.literal("review"), v.literal("done"), v.literal("blocked"));
const relationType = v.union(v.literal("related_to"), v.literal("parent_of"), v.literal("depends_on"));
const project = v.object({ id: v.id("projects"), name: v.string(), description: v.string(), status: v.union(v.literal("active"), v.literal("archived")) });
const projectLink = v.object({ id: v.id("projectLinks"), sourceProjectId: v.id("projects"), targetProjectId: v.id("projects"), relationType, description: v.string(), createdAt: v.number() });
const knowledge = v.object({ id: v.id("projectKnowledge"), projectId: v.id("projects"), kind: v.union(v.literal("module"), v.literal("function"), v.literal("data"), v.literal("capability"), v.literal("integration"), v.literal("decision")), title: v.string(), summary: v.string(), source: v.string(), tags: v.array(v.string()) });
const task = v.object({ id: v.id("tasks"), projectId: v.id("projects"), title: v.string(), description: v.string(), status, priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")), assigneeAgentId: v.union(v.id("agents"), v.null()), createdByType: v.union(v.literal("human"), v.literal("agent")), createdById: v.string(), updatedAt: v.number() });
const note = v.object({ id: v.string(), title: v.union(v.string(), v.null()), content: v.string(), status: v.union(v.literal("open"), v.literal("attended")), projectId: v.union(v.id("projects"), v.null()), updatedAt: v.number() });
const image = v.object({ id: v.id("noteImages"), projectId: v.union(v.id("projects"), v.null()), noteId: v.union(v.string(), v.null()), filename: v.string(), contentType: v.string(), size: v.number(), url: v.union(v.string(), v.null()), createdAt: v.number() });
export const asegurarWorkspace = mutation({
  args: {},
  returns: v.object({ id: v.id("workspaces"), name: v.string() }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = await getAuthUserId(ctx);
    if (!identity?.tokenIdentifier || !userId) throw new ConvexError("Inicia sesión para crear tu workspace.");

    const existing = await ctx.db.query("webAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing) {
      const workspace = await ctx.db.get(existing.workspaceId);
      if (!workspace) throw new ConvexError("El workspace de esta cuenta ya no está disponible.");
      if (existing.tokenIdentifier !== identity.tokenIdentifier) await ctx.db.patch(existing._id, { tokenIdentifier: identity.tokenIdentifier });
      return { id: workspace._id, name: workspace.name };
    }

    const email = typeof identity.email === "string" ? identity.email.trim().toLowerCase() : "";
    const verified = (identity as typeof identity & { emailVerified?: boolean }).emailVerified === true;
    const allowedEmail = env.MITPAD_WEB_ALLOWED_EMAIL?.trim().toLowerCase();
    const legacyWorkspace = await ctx.db.query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal()))
      .unique();

    // Solo se enlaza el espacio anterior cuando la cuenta demuestra poseer el correo.
    // Password no activa verificación por defecto; se mantiene aislado hasta configurar email OTP.
    let workspace = null;
    if (legacyWorkspace && verified && email && allowedEmail && email === allowedEmail) {
      workspace = legacyWorkspace;
    } else {
      const now = Date.now();
      const workspaceId = await ctx.db.insert("workspaces", {
        ownerId: userId, name: "Mi espacio", createdAt: now, updatedAt: now,
      });
      workspace = await ctx.db.get(workspaceId);
    }
    if (!workspace) throw new ConvexError("No se pudo crear el workspace de esta cuenta.");

    if (workspace === legacyWorkspace) {
      const legacyNotes = await ctx.db.query("notes")
        .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userIdPersonal()))
        .take(500);
      for (const note of legacyNotes) {
        if (!note.workspaceId) await ctx.db.patch(note._id, { workspaceId: workspace._id });
      }
    }

    await ctx.db.insert("webAccounts", {
      tokenIdentifier: identity.tokenIdentifier, userId, workspaceId: workspace._id, createdAt: Date.now(),
    });
    return { id: workspace._id, name: workspace.name };
  },
});

// The owner explicitly requested a one-time link from the newly created password account
// to Mitpad's existing personal workspace. Only the allowlisted account can claim it.
export const vincularDatosAnteriores = mutation({
  args: {},
  returns: v.object({ linked: v.boolean(), notes: v.number(), projects: v.number(), workspaceName: v.string() }),
  handler: async (ctx) => {
    const { identity, userId, workspace } = await exigirWeb(ctx);
    const email = typeof identity.email === "string" ? identity.email.trim().toLowerCase() : "";
    const allowedEmail = env.MITPAD_WEB_ALLOWED_EMAIL?.trim().toLowerCase();
    // This is also called during normal login. Other accounts should simply keep
    // their private workspace and never learn anything about the legacy data.
    if (!email || !allowedEmail || email !== allowedEmail) return { linked: false, notes: 0, projects: 0, workspaceName: workspace.name };

    const account = await ctx.db.query("webAccounts").withIndex("by_userId", q => q.eq("userId", userId)).unique();
    if (!account) return { linked: false, notes: 0, projects: 0, workspaceName: workspace.name };
    const legacy = await ctx.db.query("workspaces").withIndex("by_ownerId", q => q.eq("ownerId", userIdPersonal())).unique();
    if (!legacy) return { linked: false, notes: 0, projects: 0, workspaceName: workspace.name };
    if (account.workspaceId === legacy._id) return { linked: false, notes: 0, projects: 0, workspaceName: legacy.name };
    if (workspace._id !== account.workspaceId) return { linked: false, notes: 0, projects: 0, workspaceName: workspace.name };

    const [currentProjects, currentTasks, currentNotes, currentLinks, currentImages, currentKnowledge] = await Promise.all([
      ctx.db.query("projects").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).take(1),
      ctx.db.query("tasks").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).take(1),
      ctx.db.query("notes").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).take(1),
      ctx.db.query("projectLinks").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).take(1),
      ctx.db.query("noteImages").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).take(1),
      ctx.db.query("projectKnowledge").withIndex("by_workspaceId_and_projectId", q => q.eq("workspaceId", workspace._id)).take(1),
    ]);
    if ([currentProjects, currentTasks, currentNotes, currentLinks, currentImages, currentKnowledge].some(rows => rows.length > 0)) {
      return { linked: false, notes: 0, projects: 0, workspaceName: workspace.name };
    }

    const notes = await ctx.db.query("notes")
      .withIndex("by_userId_and_updatedAt", q => q.eq("userId", userIdPersonal()))
      .take(501);
    if (notes.length > 500 || notes.some(note => note.workspaceId && note.workspaceId !== legacy._id)) {
      return { linked: false, notes: 0, projects: 0, workspaceName: workspace.name };
    }

    const projects = await ctx.db.query("projects").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", legacy._id)).take(500);
    for (const note of notes) if (!note.workspaceId) await ctx.db.patch(note._id, { workspaceId: legacy._id });
    await ctx.db.patch(account._id, { workspaceId: legacy._id });
    return { linked: true, notes: notes.filter(note => !note.workspaceId).length, projects: projects.length, workspaceName: legacy.name };
  },
});

export const dashboard = query({
  args: {},
  returns: v.object({ projects: v.array(project), projectLinks: v.array(projectLink), knowledge: v.array(knowledge), tasks: v.array(task), agents: v.array(v.object({ id: v.id("agents"), name: v.string(), model: v.string(), clientType: v.string(), credentialMode: v.union(v.literal("local"), v.literal("mcp"), v.null()), active: v.boolean(), lastSeenAt: v.union(v.number(), v.null()) })), events: v.array(v.object({ id: v.id("activityEvents"), summary: v.string(), actorType: v.union(v.literal("human"), v.literal("agent")), actorId: v.string(), createdAt: v.number() })), notes: v.array(note), images: v.array(image) }),
  handler: async (ctx) => {
    const { workspace } = await exigirWeb(ctx);
    const [projects, projectLinks, knowledge, tasks, agents, events, notes, images] = await Promise.all([
      ctx.db.query("projects").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(300),
      ctx.db.query("projectLinks").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("asc").take(1000),
      ctx.db.query("projectKnowledge").withIndex("by_workspaceId_and_projectId", q => q.eq("workspaceId", workspace._id)).take(1000),
      ctx.db.query("tasks").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(500),
      ctx.db.query("agents").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(200),
      ctx.db.query("activityEvents").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(100),
      ctx.db.query("notes").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(200),
      ctx.db.query("noteImages").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(200),
    ]);
    return {
      projects: projects.map(p => ({ id: p._id, name: p.name, description: p.description, status: p.status })),
      projectLinks: projectLinks.map(link => ({ id: link._id, sourceProjectId: link.sourceProjectId, targetProjectId: link.targetProjectId, relationType: link.relationType, description: link.description ?? "", createdAt: link.createdAt })),
      knowledge: knowledge.map(item => ({ id: item._id, projectId: item.projectId, kind: item.kind, title: item.title, summary: item.summary, source: item.source, tags: item.tags })),
      tasks: tasks.map(t => ({ id: t._id, projectId: t.projectId, title: t.title, description: t.description, status: t.status, priority: t.priority, assigneeAgentId: t.assigneeAgentId ?? null, createdByType: t.createdByType, createdById: t.createdById, updatedAt: t.updatedAt })),
      agents: agents.map(a => ({ id: a._id, name: a.name, model: a.model, clientType: a.clientType, credentialMode: a.credentialMode ?? null, active: a.active, lastSeenAt: a.lastSeenAt ?? null })),
      events: events.map(e => ({ id: e._id, summary: e.summary, actorType: e.actorType, actorId: e.actorId, createdAt: e.createdAt })),
      notes: notes.filter(n => n.deletedAt === undefined).map(n => ({ id: n.uuid, title: n.title ?? null, content: n.content, status: n.status ?? "open" as const, projectId: n.projectId ?? null, updatedAt: n.updatedAt })),
      images: await Promise.all(images.map(async (i) => ({ id: i._id, projectId: i.projectId ?? null, noteId: i.noteId ?? null, filename: i.filename, contentType: i.contentType, size: i.size, url: await ctx.storage.getUrl(i.storageId), createdAt: i.createdAt }))),
    };
  },
});

export const editarProyecto = mutation({
  args: { projectId: v.id("projects"), name: v.string(), description: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { workspace, identity } = await exigirWeb(ctx);
    const current = await ctx.db.get(args.projectId);
    if (!current || current.workspaceId !== workspace._id) throw new ConvexError("El proyecto no pertenece al workspace.");
    const name = args.name.trim();
    const description = args.description.trim();
    if (!name || name.length > 120 || description.length > 20000) throw new ConvexError("Revisa el nombre y la descripción del proyecto.");
    await ctx.db.patch(args.projectId, { name, description, updatedAt: Date.now() });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: args.projectId, actorType: "human", actorId: identity.tokenIdentifier, eventType: "project_updated", entityType: "project", entityId: args.projectId, summary: `Actualizó el proyecto ${name}`, createdAt: Date.now() });
    return null;
  },
});

export const crearRelacionProyectos = mutation({
  args: { sourceProjectId: v.id("projects"), targetProjectId: v.id("projects"), relationType, description: v.string() },
  returns: v.id("projectLinks"),
  handler: async (ctx, args) => {
    const { workspace, identity } = await exigirWeb(ctx);
    if (args.sourceProjectId === args.targetProjectId) throw new ConvexError("Elige dos proyectos diferentes.");
    if (args.description.length > 1000) throw new ConvexError("La descripción supera 1000 caracteres.");
    const [source, target] = await Promise.all([ctx.db.get(args.sourceProjectId), ctx.db.get(args.targetProjectId)]);
    if (!source || !target || source.workspaceId !== workspace._id || target.workspaceId !== workspace._id) throw new ConvexError("Ambos proyectos deben pertenecer al workspace.");
    const prior = await ctx.db.query("projectLinks").withIndex("by_sourceProjectId_and_targetProjectId", q => q.eq("sourceProjectId", args.sourceProjectId).eq("targetProjectId", args.targetProjectId)).unique();
    const description = args.description.trim();
    if (prior) {
      if (prior.workspaceId !== workspace._id) throw new ConvexError("La relación pertenece a otro workspace.");
      await ctx.db.patch(prior._id, { relationType: args.relationType, description: description || undefined, createdAt: Date.now() });
      return prior._id;
    }
    const id = await ctx.db.insert("projectLinks", { workspaceId: workspace._id, sourceProjectId: args.sourceProjectId, targetProjectId: args.targetProjectId, relationType: args.relationType, description: description || undefined, createdAt: Date.now() });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: args.sourceProjectId, actorType: "human", actorId: identity.tokenIdentifier, eventType: "project_updated", entityType: "project", entityId: args.sourceProjectId, summary: `Relacionó ${source.name} con ${target.name}`, details: description || undefined, createdAt: Date.now() });
    return id;
  },
});

export const borrarRelacionProyecto = mutation({
  args: { linkId: v.id("projectLinks") },
  returns: v.boolean(),
  handler: async (ctx, { linkId }) => {
    const { workspace } = await exigirWeb(ctx);
    const link = await ctx.db.get(linkId);
    if (!link || link.workspaceId !== workspace._id) return false;
    await ctx.db.delete(linkId);
    return true;
  },
});

// Agents authenticate to the remote REST/MCP API with this per-agent key.
// Only its SHA-256 hash is persisted; the raw credential is returned once.
export const crearCredencialAgente = mutation({
  args: { name: v.string(), model: v.string(), modelProvider: v.string(), clientType: v.string() },
  returns: v.object({ id: v.id("agents"), name: v.string(), apiKey: v.string() }),
  handler: async (ctx, args) => {
    const { workspace, identity } = await exigirWeb(ctx);
    for (const [field, value, max] of [["name", args.name, 100], ["model", args.model, 120], ["modelProvider", args.modelProvider, 80], ["clientType", args.clientType, 80]] as const) {
      if (!value.trim() || value.length > max) throw new ConvexError(`${field} es obligatorio y debe tener máximo ${max} caracteres.`);
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const apiKey = `pha_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const apiKeyHash = await hashAgentApiKey(apiKey);
    const now = Date.now();
    const id = await ctx.db.insert("agents", {
      workspaceId: workspace._id, name: args.name.trim(), model: args.model.trim(), modelProvider: args.modelProvider.trim(),
      clientType: args.clientType.trim(), pilot: identity.email ?? "workspace owner", apiKeyHash, credentialMode: "mcp", active: true, createdAt: now,
    });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, actorType: "human", actorId: identity.tokenIdentifier, eventType: "agent_registered", entityType: "agent", entityId: id, summary: `Registró el agente remoto ${args.name.trim()}`, createdAt: now });
    return { id, name: args.name.trim(), apiKey };
  },
});

export const revocarCredencialAgente = mutation({
  args: { agentId: v.id("agents") },
  returns: v.boolean(),
  handler: async (ctx, { agentId }) => {
    const { workspace, identity } = await exigirWeb(ctx);
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.workspaceId !== workspace._id) return false;
    if (agent.credentialMode !== "mcp") return false;
    if (!agent.active) return true;
    await ctx.db.patch(agentId, { active: false });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, actorType: "human", actorId: identity.tokenIdentifier, eventType: "agent_revoked", entityType: "agent", entityId: agentId, summary: `Revocó la clave de ${agent.name}`, createdAt: Date.now() });
    return true;
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
    if (existing?.deletedAt !== undefined) throw new ConvexError("La nota fue eliminada; crea una nota nueva.");
    const noteId = args.id ?? crypto.randomUUID();
    if (existing) await ctx.db.patch(existing._id, { title: args.title.trim() || undefined, content: args.content, projectId: args.projectId ?? undefined, status: args.status ?? existing.status ?? "open", updatedAt: now });
    else await ctx.db.insert("notes", { uuid: noteId, userId: identity.tokenIdentifier, workspaceId: workspace._id, projectId: args.projectId ?? undefined, kind: "note", title: args.title.trim() || undefined, content: args.content, status: args.status ?? "open", createdAt: now, updatedAt: now });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: args.projectId ?? undefined, actorType: "human", actorId: identity.tokenIdentifier, eventType: existing ? "note_updated" : "note_created", entityType: "note", entityId: noteId, summary: `${existing ? "Actualizó" : "Creó"} la nota ${args.title.trim() || "sin título"}`, createdAt: now });
    return noteId;
  },
});

export const borrarNota = mutation({
  args: { id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id }) => {
    const { workspace, identity } = await exigirWeb(ctx);
    const note = await ctx.db.query("notes").withIndex("by_uuid", q => q.eq("uuid", id)).unique();
    if (!note) return false;
    if (note.workspaceId !== workspace._id) throw new ConvexError("La nota no pertenece al workspace.");
    if (note.deletedAt !== undefined) return true;
    for await (const link of ctx.db.query("noteLinks").withIndex("by_sourceNoteId_and_targetNoteId", q => q.eq("sourceNoteId", id))) await ctx.db.delete("noteLinks", link._id);
    for await (const link of ctx.db.query("noteLinks").withIndex("by_targetNoteId", q => q.eq("targetNoteId", id))) await ctx.db.delete("noteLinks", link._id);
    for await (const image of ctx.db.query("noteImages").withIndex("by_noteId_and_createdAt", q => q.eq("noteId", id))) {
      await ctx.storage.delete(image.storageId);
      await ctx.db.delete("noteImages", image._id);
    }
    const now = Date.now();
    await ctx.db.patch("notes", note._id, { title: undefined, content: "", projectId: undefined, deletedAt: now, updatedAt: now });
    await ctx.db.insert("activityEvents", { workspaceId: workspace._id, projectId: note.projectId, actorType: "human", actorId: identity.tokenIdentifier, eventType: "note_deleted", entityType: "note", entityId: id, summary: `Eliminó la nota ${note.title ?? "sin título"}`, createdAt: now });
    return true;
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

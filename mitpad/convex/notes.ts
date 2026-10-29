// Notas: lo que la cola local (sync_queue) de la app sube a la nube.
// Las tres operaciones son idempotentes: si el worker reintenta tras un corte,
// no se duplica ni falla nada.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { exigirToken, exigirUsuario, userIdPersonal } from "./acceso";
import { asegurarWorkspace } from "./workspaces";

const MAX_CONTENIDO = 500_000;
const notaValidator = v.object({
  id: v.string(), user_id: v.string(), title: v.union(v.string(), v.null()), content: v.string(),
  created_at: v.number(), updated_at: v.number(), workspace_id: v.union(v.id("workspaces"), v.null()),
  project_id: v.union(v.id("projects"), v.null()), kind: v.union(v.literal("note"), v.literal("memory"), v.null()),
  status: v.union(v.literal("open"), v.literal("attended"), v.null()),
});

function publica(n: Doc<"notes">) {
  return {
    id: n.uuid,
    user_id: n.userId,
    title: n.title ?? null,
    content: n.content,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    workspace_id: n.workspaceId ?? null,
    project_id: n.projectId ?? null,
    kind: n.kind ?? "note",
    status: n.status ?? "open",
  };
}

/** INSERT ... ON CONFLICT (id) DO NOTHING */
export const crear = mutation({
  args: {
    token: v.string(),
    id: v.string(),
    userId: v.string(),
    title: v.optional(v.union(v.string(), v.null())),
    content: v.string(),
    status: v.optional(v.union(v.literal("open"), v.literal("attended"))),
  },
  returns: v.boolean(),
  handler: async (ctx, { token, id, userId, title, content, status }) => {
    exigirToken(token);
    exigirUsuario(userId);
    if (content.length > MAX_CONTENIDO) throw new Error("Nota demasiado larga.");
    const existe = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (existe) return false;
    const ahora = Date.now();
    const workspaceId = await asegurarWorkspace(ctx, userIdPersonal());
    await ctx.db.insert("notes", { uuid: id, userId, workspaceId, title: title ?? undefined, content, status: status ?? "open", createdAt: ahora, updatedAt: ahora });
    return true;
  },
});

export const actualizar = mutation({
  args: {
    token: v.string(),
    id: v.string(),
    title: v.optional(v.union(v.string(), v.null())),
    content: v.string(),
    status: v.optional(v.union(v.literal("open"), v.literal("attended"))),
  },
  returns: v.boolean(),
  handler: async (ctx, { token, id, title, content, status }) => {
    exigirToken(token);
    if (content.length > MAX_CONTENIDO) throw new Error("Nota demasiado larga.");
    const nota = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (!nota || nota.deletedAt !== undefined) return false; // no resucitar una nota borrada
    exigirUsuario(nota.userId);
    const workspaceId = await asegurarWorkspace(ctx, userIdPersonal());
    await ctx.db.patch("notes", nota._id, { title: title ?? undefined, content, workspaceId, status: status ?? nota.status ?? "open", updatedAt: Date.now() });
    return true;
  },
});

/** Borra la nota y sus enlaces (antes: ON DELETE CASCADE). */
export const borrar = mutation({
  args: { token: v.string(), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { token, id }) => {
    exigirToken(token);
    const nota = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (!nota) return false;
    exigirUsuario(nota.userId);
    if (nota.deletedAt !== undefined) return true;
    for await (const link of ctx.db.query("noteLinks").withIndex("by_sourceNoteId_and_targetNoteId", (q) => q.eq("sourceNoteId", id))) {
      await ctx.db.delete("noteLinks", link._id);
    }
    for await (const link of ctx.db.query("noteLinks").withIndex("by_targetNoteId", (q) => q.eq("targetNoteId", id))) {
      await ctx.db.delete("noteLinks", link._id);
    }
    for await (const image of ctx.db.query("noteImages").withIndex("by_noteId_and_createdAt", (q) => q.eq("noteId", id))) {
      await ctx.storage.delete(image.storageId);
      await ctx.db.delete("noteImages", image._id);
    }
    const now = Date.now();
    await ctx.db.patch("notes", nota._id, { title: undefined, content: "", projectId: undefined, deletedAt: now, updatedAt: now });
    return true;
  },
});

/** Las notas de un usuario, la más reciente primero (para traerlas a otro equipo). */
export const listar = query({
  args: { token: v.string(), userId: v.string(), limite: v.optional(v.number()) },
  returns: v.array(notaValidator),
  handler: async (ctx, { token, userId, limite }) => {
    exigirToken(token);
    exigirUsuario(userId);
    const notas = await ctx.db
      .query("notes")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(limite ?? 200, 1000));
    return notas.filter((nota) => nota.deletedAt === undefined).map(publica);
  },
});

/** Vincula una nota existente al proyecto elegido para que funcione como memoria del proyecto. */
export const asignarProyecto = mutation({
  args: {
    token: v.string(), id: v.string(), projectId: v.union(v.id("projects"), v.null()),
    kind: v.optional(v.union(v.literal("note"), v.literal("memory"))),
  },
  returns: notaValidator,
  handler: async (ctx, { token, id, projectId, kind }) => {
    exigirToken(token);
    const note = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (!note || note.deletedAt !== undefined) throw new Error("La nota no existe.");
    exigirUsuario(note.userId);
    const workspaceId = await asegurarWorkspace(ctx, userIdPersonal());
    if (projectId) {
      const project = await ctx.db.get(projectId);
      if (!project || project.workspaceId !== workspaceId) throw new Error("El proyecto no pertenece a este espacio.");
    }
    await ctx.db.patch(note._id, { workspaceId, projectId: projectId ?? undefined, kind: kind ?? note.kind ?? "note", updatedAt: Date.now() });
    await ctx.db.insert("activityEvents", {
      workspaceId, projectId: projectId ?? undefined, actorType: "human", actorId: "pilot",
      eventType: "note_linked", entityType: "note", entityId: id,
      summary: projectId ? `Vinculó la nota ${note.title ?? "sin título"} a un proyecto` : `Desvinculó la nota ${note.title ?? "sin título"} del proyecto`,
      createdAt: Date.now(),
    });
    const updated = await ctx.db.get(note._id);
    if (!updated) throw new Error("No se pudo actualizar la nota.");
    return publica(updated);
  },
});

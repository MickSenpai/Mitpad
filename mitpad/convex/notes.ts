// Notas: lo que la cola local (sync_queue) de la app sube a la nube.
// Las tres operaciones son idempotentes: si el worker reintenta tras un corte,
// no se duplica ni falla nada.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { exigirToken } from "./acceso";

const MAX_CONTENIDO = 500_000;

function publica(n: Doc<"notes">) {
  return {
    id: n.uuid,
    user_id: n.userId,
    title: n.title ?? null,
    content: n.content,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
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
  },
  handler: async (ctx, { token, id, userId, title, content }) => {
    exigirToken(token);
    if (content.length > MAX_CONTENIDO) throw new Error("Nota demasiado larga.");
    const existe = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (existe) return false;
    const ahora = Date.now();
    await ctx.db.insert("notes", {
      uuid: id, userId, title: title ?? undefined, content, createdAt: ahora, updatedAt: ahora,
    });
    return true;
  },
});

export const actualizar = mutation({
  args: {
    token: v.string(),
    id: v.string(),
    title: v.optional(v.union(v.string(), v.null())),
    content: v.string(),
  },
  handler: async (ctx, { token, id, title, content }) => {
    exigirToken(token);
    if (content.length > MAX_CONTENIDO) throw new Error("Nota demasiado larga.");
    const nota = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (!nota) return false; // como el UPDATE de antes: si no existe, no hace nada
    await ctx.db.patch("notes", nota._id, { title: title ?? undefined, content, updatedAt: Date.now() });
    return true;
  },
});

/** Borra la nota y sus enlaces (antes: ON DELETE CASCADE). */
export const borrar = mutation({
  args: { token: v.string(), id: v.string() },
  handler: async (ctx, { token, id }) => {
    exigirToken(token);
    const nota = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (!nota) return false;
    const salientes = await ctx.db
      .query("noteLinks")
      .withIndex("by_sourceNoteId_and_targetNoteId", (q) => q.eq("sourceNoteId", id))
      .take(1000);
    const entrantes = await ctx.db
      .query("noteLinks")
      .withIndex("by_targetNoteId", (q) => q.eq("targetNoteId", id))
      .take(1000);
    for (const l of [...salientes, ...entrantes]) await ctx.db.delete("noteLinks", l._id);
    await ctx.db.delete("notes", nota._id);
    return true;
  },
});

/** Las notas de un usuario, la más reciente primero (para traerlas a otro equipo). */
export const listar = query({
  args: { token: v.string(), userId: v.string(), limite: v.optional(v.number()) },
  handler: async (ctx, { token, userId, limite }) => {
    exigirToken(token);
    const notas = await ctx.db
      .query("notes")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(limite ?? 200, 1000));
    return notas.map(publica);
  },
});

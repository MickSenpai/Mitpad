// Enlaces entre notas (tipo Obsidian). Un par origen -> destino solo existe una vez.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { exigirToken, exigirUsuario } from "./acceso";

export const crear = mutation({
  args: { token: v.string(), id: v.string(), sourceNoteId: v.string(), targetNoteId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { token, id, sourceNoteId, targetNoteId }) => {
    exigirToken(token);
    for (const nota of [sourceNoteId, targetNoteId]) {
      const existe = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", nota)).unique();
      if (!existe) throw new ConvexError(`No existe la nota ${nota}.`);
      exigirUsuario(existe.userId);
    }
    const repetido = await ctx.db
      .query("noteLinks")
      .withIndex("by_sourceNoteId_and_targetNoteId", (q) =>
        q.eq("sourceNoteId", sourceNoteId).eq("targetNoteId", targetNoteId),
      )
      .unique();
    if (repetido) return false;
    await ctx.db.insert("noteLinks", { uuid: id, sourceNoteId, targetNoteId, createdAt: Date.now() });
    return true;
  },
});

export const borrar = mutation({
  args: { token: v.string(), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { token, id }) => {
    exigirToken(token);
    const l = await ctx.db.query("noteLinks").withIndex("by_uuid", (q) => q.eq("uuid", id)).unique();
    if (!l) return false;
    for (const noteId of [l.sourceNoteId, l.targetNoteId]) {
      const note = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", noteId)).unique();
      if (!note) throw new ConvexError("No existe una nota asociada al enlace.");
      exigirUsuario(note.userId);
    }
    await ctx.db.delete("noteLinks", l._id);
    return true;
  },
});

/** Enlaces que salen de una nota. */
export const deNota = query({
  args: { token: v.string(), noteId: v.string() },
  returns: v.array(v.object({ id: v.string(), source_note_id: v.string(), target_note_id: v.string() })),
  handler: async (ctx, { token, noteId }) => {
    exigirToken(token);
    const note = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", noteId)).unique();
    if (!note) throw new ConvexError("No existe la nota asociada al enlace.");
    exigirUsuario(note.userId);
    const filas = await ctx.db
      .query("noteLinks")
      .withIndex("by_sourceNoteId_and_targetNoteId", (q) => q.eq("sourceNoteId", noteId))
      .take(500);
    return filas.map((l) => ({ id: l.uuid, source_note_id: l.sourceNoteId, target_note_id: l.targetNoteId }));
  },
});

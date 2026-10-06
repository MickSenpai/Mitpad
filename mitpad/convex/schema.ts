// Nube de Mitpad (antes en Neon). Los ids de notas y usuarios los genera la app
// (UUID v4, igual que en su SQLite local), así una nota creada sin red conserva
// su id al subirse. Las fechas son milisegundos desde 1970.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    uuid: v.string(),
    nombre: v.string(),
    entorno: v.optional(v.string()),
    gustos: v.optional(v.any()),
    odia: v.optional(v.any()),
    proyectos: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_uuid", ["uuid"]),

  notes: defineTable({
    uuid: v.string(),
    userId: v.string(), // uuid del usuario
    title: v.optional(v.string()),
    content: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_uuid", ["uuid"])
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"]),

  // Relaciones entre notas, tipo Obsidian
  noteLinks: defineTable({
    uuid: v.string(),
    sourceNoteId: v.string(), // uuid de la nota
    targetNoteId: v.string(),
    createdAt: v.number(),
  })
    .index("by_uuid", ["uuid"])
    .index("by_sourceNoteId_and_targetNoteId", ["sourceNoteId", "targetNoteId"])
    .index("by_targetNoteId", ["targetNoteId"]),
});

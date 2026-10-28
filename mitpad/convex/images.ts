import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { exigirToken, userIdPersonal } from "./acceso";
import { asegurarWorkspace } from "./workspaces";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_COUNT = 200;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const imageValidator = v.object({
  id: v.id("noteImages"), workspaceId: v.id("workspaces"), noteId: v.union(v.string(), v.null()),
  projectId: v.union(v.id("projects"), v.null()), filename: v.string(), contentType: v.string(),
  size: v.number(), createdAt: v.number(), url: v.union(v.string(), v.null()),
});

async function ownerWorkspace(ctx: QueryCtx | MutationCtx) {
  return await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal())).unique();
}

async function verifyTarget(ctx: QueryCtx | MutationCtx, noteId?: string, projectId?: Id<"projects">) {
  if (noteId === undefined && projectId === undefined) throw new ConvexError("La imagen debe estar ligada a una nota o a un proyecto.");
  const workspace = await ownerWorkspace(ctx);
  if (!workspace) throw new ConvexError("Primero crea tu espacio personal.");
  if (noteId !== undefined) {
    const note = await ctx.db.query("notes").withIndex("by_uuid", (q) => q.eq("uuid", noteId)).unique();
    if (!note || note.userId !== userIdPersonal()) throw new ConvexError("La nota no pertenece a este espacio.");
    if (note.workspaceId && note.workspaceId !== workspace._id) throw new ConvexError("La nota está ligada a otro espacio.");
    if (projectId && note.projectId !== projectId) throw new ConvexError("El proyecto no coincide con la nota.");
    if (note.projectId) {
      const project = await ctx.db.get(note.projectId);
      if (!project || project.workspaceId !== workspace._id) throw new ConvexError("El proyecto de la nota no pertenece a este espacio.");
    }
    return workspace._id;
  }
  const project = await ctx.db.get(projectId!);
  if (!project || project.workspaceId !== workspace._id) throw new ConvexError("El proyecto no pertenece a este espacio.");
  return workspace._id;
}

async function existingImages(ctx: MutationCtx, noteId?: string, projectId?: Id<"projects">) {
  return noteId !== undefined
    ? await ctx.db.query("noteImages").withIndex("by_noteId_and_createdAt", (q) => q.eq("noteId", noteId)).take(MAX_COUNT)
    : await ctx.db.query("noteImages").withIndex("by_projectId_and_createdAt", (q) => q.eq("projectId", projectId!)).take(MAX_COUNT);
}

/** Genera una URL temporal de carga tras comprobar el propietario del destino. */
export const crearUrlSubida = mutation({
  args: { token: v.string(), noteId: v.optional(v.string()), projectId: v.optional(v.id("projects")) },
  returns: v.string(),
  handler: async (ctx, { token, noteId, projectId }) => {
    exigirToken(token);
    await verifyTarget(ctx, noteId, projectId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Registra la imagen ya subida y valida MIME, tamaño y cuota del destino. */
export const registrar = mutation({
  args: {
    token: v.string(), noteId: v.optional(v.string()), projectId: v.optional(v.id("projects")),
    storageId: v.id("_storage"), filename: v.string(),
  },
  returns: v.id("noteImages"),
  handler: async (ctx, { token, noteId, projectId, storageId, filename }) => {
    exigirToken(token);
    const workspaceId = await verifyTarget(ctx, noteId, projectId);
    if (!filename.trim() || filename.length > 255) throw new ConvexError("El nombre del archivo no es válido.");
    const metadata = await ctx.db.system.get("_storage", storageId);
    if (!metadata) throw new ConvexError("No se encontró el archivo cargado.");
    if (!MIME_TYPES.has(metadata.contentType ?? "")) throw new ConvexError("Formato no admitido; usa JPEG, PNG, WebP o GIF.");
    if (metadata.size > MAX_BYTES) throw new ConvexError("La imagen supera el límite de 10 MB.");
    const previous = await existingImages(ctx, noteId, projectId);
    if (previous.length >= MAX_COUNT) throw new ConvexError("El destino ya tiene el máximo de 200 imágenes.");
    if (previous.reduce((total, image) => total + image.size, 0) + metadata.size > MAX_TOTAL_BYTES) {
      throw new ConvexError("Los adjuntos de este destino no pueden superar 50 MB en total.");
    }
    return await ctx.db.insert("noteImages", {
      workspaceId, noteId, projectId, storageId, filename: filename.trim(),
      contentType: metadata.contentType ?? "application/octet-stream", size: metadata.size, createdAt: Date.now(),
    });
  },
});

export const deNota = query({
  args: { token: v.string(), noteId: v.string() },
  returns: v.array(imageValidator),
  handler: async (ctx, { token, noteId }) => {
    exigirToken(token);
    const workspaceId = await verifyTarget(ctx, noteId, undefined);
    const images = await ctx.db.query("noteImages").withIndex("by_noteId_and_createdAt", (q) => q.eq("noteId", noteId)).order("asc").take(MAX_COUNT);
    return await Promise.all(images.map(async (image) => ({
      id: image._id, workspaceId, noteId: image.noteId ?? null, projectId: image.projectId ?? null,
      filename: image.filename, contentType: image.contentType, size: image.size, createdAt: image.createdAt,
      url: await ctx.storage.getUrl(image.storageId),
    })));
  },
});

export const deProyecto = query({
  args: { token: v.string(), projectId: v.id("projects") },
  returns: v.array(imageValidator),
  handler: async (ctx, { token, projectId }) => {
    exigirToken(token);
    const workspaceId = await verifyTarget(ctx, undefined, projectId);
    const images = await ctx.db.query("noteImages").withIndex("by_projectId_and_createdAt", (q) => q.eq("projectId", projectId)).order("asc").take(MAX_COUNT);
    return await Promise.all(images.map(async (image) => ({
      id: image._id, workspaceId, noteId: image.noteId ?? null, projectId: image.projectId ?? null,
      filename: image.filename, contentType: image.contentType, size: image.size, createdAt: image.createdAt,
      url: await ctx.storage.getUrl(image.storageId),
    })));
  },
});

export const borrar = mutation({
  args: { token: v.string(), imageId: v.id("noteImages") },
  returns: v.boolean(),
  handler: async (ctx, { token, imageId }) => {
    exigirToken(token);
    const image = await ctx.db.get(imageId);
    if (!image) return false;
    const workspace = await ownerWorkspace(ctx);
    if (!workspace || image.workspaceId !== workspace._id) throw new ConvexError("La imagen no pertenece a este espacio.");
    await ctx.storage.delete(image.storageId);
    await ctx.db.delete(imageId);
    return true;
  },
});

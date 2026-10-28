import { v } from "convex/values";
import { internalMutation, query, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { exigirToken, userIdPersonal } from "./acceso";

const workspaceValidator = v.object({
  id: v.id("workspaces"),
  ownerId: v.string(),
  name: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export async function asegurarWorkspace(ctx: MutationCtx, ownerId: string, name = "Mi espacio") {
  const existente = await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).unique();
  if (existente) return existente._id as Id<"workspaces">;
  const ahora = Date.now();
  return await ctx.db.insert("workspaces", { ownerId, name: name.trim().slice(0, 120) || "Mi espacio", createdAt: ahora, updatedAt: ahora });
}

/** Retorna o crea el espacio personal histórico de Mitpad. */
export const asegurarPersonal = mutation({
  args: { token: v.string(), nombre: v.optional(v.string()) },
  returns: workspaceValidator,
  handler: async (ctx, { token, nombre }) => {
    exigirToken(token);
    const ownerId = userIdPersonal();
    const id = await asegurarWorkspace(ctx, ownerId, nombre);
    const workspace = await ctx.db.get(id);
    if (!workspace) throw new Error("No se pudo crear el espacio personal.");
    return { id: workspace._id, ownerId: workspace.ownerId, name: workspace.name, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt };
  },
});

export const miEspacio = query({
  args: { token: v.string() },
  returns: v.union(workspaceValidator, v.null()),
  handler: async (ctx, { token }) => {
    exigirToken(token);
    const ownerId = userIdPersonal();
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).unique();
    return workspace ? { id: workspace._id, ownerId: workspace.ownerId, name: workspace.name, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt } : null;
  },
});

export const asegurarPorOwner = internalMutation({
  args: { ownerId: v.string(), name: v.optional(v.string()) },
  returns: v.id("workspaces"),
  handler: async (ctx, { ownerId, name }) => await asegurarWorkspace(ctx, ownerId, name),
});

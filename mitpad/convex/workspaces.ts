import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export async function asegurarWorkspace(ctx: MutationCtx, ownerId: string, name = "Mi espacio") {
  const existente = await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId)).unique();
  if (existente) return existente._id as Id<"workspaces">;
  const ahora = Date.now();
  return await ctx.db.insert("workspaces", { ownerId, name: name.trim().slice(0, 120) || "Mi espacio", createdAt: ahora, updatedAt: ahora });
}

/** Retorna o crea el espacio personal histórico de Mitpad. */
export const asegurarPorOwner = internalMutation({
  args: { ownerId: v.string(), name: v.optional(v.string()) },
  returns: v.id("workspaces"),
  handler: async (ctx, { ownerId, name }) => await asegurarWorkspace(ctx, ownerId, name),
});

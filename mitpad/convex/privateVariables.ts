import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { exigirWeb } from "./webAuth";

const vaultInfo = v.object({ id: v.id("privateVaults"), salt: v.string(), checkCiphertext: v.string(), checkIv: v.string() });
const encryptedVariable = v.object({ id: v.id("privateVariables"), ciphertext: v.string(), iv: v.string(), createdAt: v.number(), updatedAt: v.number() });

function validateEnvelope(ciphertext: string, iv: string) {
  if (ciphertext.length < 20 || ciphertext.length > 200_000) throw new ConvexError("El valor cifrado no tiene un tamaño válido.");
  if (iv.length < 12 || iv.length > 64) throw new ConvexError("El vector de cifrado no tiene un tamaño válido.");
}

export const getVault = query({
  args: {},
  returns: v.union(vaultInfo, v.null()),
  handler: async (ctx) => {
    const { workspace } = await exigirWeb(ctx);
    const vault = await ctx.db.query("privateVaults").withIndex("by_workspaceId", q => q.eq("workspaceId", workspace._id)).unique();
    return vault ? { id: vault._id, salt: vault.salt, checkCiphertext: vault.checkCiphertext, checkIv: vault.checkIv } : null;
  },
});

export const createVault = mutation({
  args: { salt: v.string(), checkCiphertext: v.string(), checkIv: v.string() },
  returns: vaultInfo,
  handler: async (ctx, args) => {
    const { workspace } = await exigirWeb(ctx);
    if (args.salt.length < 20 || args.salt.length > 64) throw new ConvexError("La sal de cifrado no tiene un tamaño válido.");
    validateEnvelope(args.checkCiphertext, args.checkIv);
    const existing = await ctx.db.query("privateVaults").withIndex("by_workspaceId", q => q.eq("workspaceId", workspace._id)).unique();
    if (existing) return { id: existing._id, salt: existing.salt, checkCiphertext: existing.checkCiphertext, checkIv: existing.checkIv };
    const id = await ctx.db.insert("privateVaults", { workspaceId: workspace._id, salt: args.salt, checkCiphertext: args.checkCiphertext, checkIv: args.checkIv, createdAt: Date.now() });
    return { id, salt: args.salt, checkCiphertext: args.checkCiphertext, checkIv: args.checkIv };
  },
});

export const list = query({
  args: {},
  returns: v.array(encryptedVariable),
  handler: async (ctx) => {
    const { workspace } = await exigirWeb(ctx);
    const rows = await ctx.db.query("privateVariables").withIndex("by_workspaceId_and_updatedAt", q => q.eq("workspaceId", workspace._id)).order("desc").take(250);
    return rows.map(row => ({ id: row._id, ciphertext: row.ciphertext, iv: row.iv, createdAt: row.createdAt, updatedAt: row.updatedAt }));
  },
});

export const create = mutation({
  args: { ciphertext: v.string(), iv: v.string() },
  returns: v.id("privateVariables"),
  handler: async (ctx, args) => {
    const { workspace } = await exigirWeb(ctx);
    const vault = await ctx.db.query("privateVaults").withIndex("by_workspaceId", q => q.eq("workspaceId", workspace._id)).unique();
    if (!vault) throw new ConvexError("Primero configura tu caja privada.");
    validateEnvelope(args.ciphertext, args.iv);
    const now = Date.now();
    return await ctx.db.insert("privateVariables", { workspaceId: workspace._id, ciphertext: args.ciphertext, iv: args.iv, createdAt: now, updatedAt: now });
  },
});

export const update = mutation({
  args: { id: v.id("privateVariables"), ciphertext: v.string(), iv: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { workspace } = await exigirWeb(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.workspaceId !== workspace._id) throw new ConvexError("No se encontró esa variable privada.");
    validateEnvelope(args.ciphertext, args.iv);
    await ctx.db.patch(row._id, { ciphertext: args.ciphertext, iv: args.iv, updatedAt: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("privateVariables") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const { workspace } = await exigirWeb(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.workspaceId !== workspace._id) throw new ConvexError("No se encontró esa variable privada.");
    await ctx.db.delete(row._id);
    return null;
  },
});

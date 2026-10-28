import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export async function exigirWeb(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  const userId = await getAuthUserId(ctx);
  if (!identity?.tokenIdentifier || !userId) {
    throw new ConvexError("Inicia sesión con tu correo y contraseña para abrir tu workspace.");
  }
  const account = await ctx.db
    .query("webAccounts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique()
    ?? await ctx.db
      .query("webAccounts")
      .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
  if (!account) {
    throw new ConvexError("La sesión aún no tiene un workspace. Vuelve a entrar para crearlo.");
  }
  const workspace = await ctx.db.get(account.workspaceId);
  if (!workspace) throw new ConvexError("El workspace de esta cuenta ya no está disponible.");
  return { identity, userId, workspace };
}

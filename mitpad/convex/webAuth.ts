import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export async function exigirWeb(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.tokenIdentifier) {
    throw new ConvexError("Inicia sesión con Clerk para abrir tu workspace.");
  }
  const account = await ctx.db
    .query("webAccounts")
    .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (!account) {
    throw new ConvexError("La sesión aún no tiene un workspace. Vuelve a iniciar sesión para crearlo.");
  }
  const workspace = await ctx.db.get(account.workspaceId);
  if (!workspace) throw new ConvexError("El workspace de esta cuenta ya no está disponible.");
  return { identity, workspace };
}

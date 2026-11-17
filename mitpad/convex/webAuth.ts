import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type WorkspaceRole = "owner" | "editor";

/**
 * Resolves the signed-in person and the workspace they are currently working in: their own, or
 * another owner's when they accepted an invitation and still hold a membership row.
 */
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
  let workspaceId = account.workspaceId;
  let role: WorkspaceRole = "owner";
  if (account.activeWorkspaceId && account.activeWorkspaceId !== account.workspaceId) {
    // Access to a foreign workspace exists only while the membership row does.
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", account.activeWorkspaceId!).eq("userId", userId))
      .unique();
    if (membership) { workspaceId = account.activeWorkspaceId; role = membership.role; }
  }
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new ConvexError("El workspace de esta cuenta ya no está disponible.");
  return { identity, userId, workspace, role, ownWorkspaceId: account.workspaceId, accountId: account._id };
}

/** Like exigirWeb, but only the workspace owner may continue (members, invitations, secrets, agent keys). */
export async function exigirPropietario(ctx: QueryCtx | MutationCtx) {
  const session = await exigirWeb(ctx);
  if (session.role !== "owner") throw new ConvexError("Solo el propietario del workspace puede hacer esto.");
  return session;
}

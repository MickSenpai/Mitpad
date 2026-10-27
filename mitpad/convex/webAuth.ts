import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { env } from "./_generated/server";
import { userIdPersonal } from "./acceso";

export async function exigirWeb(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  const email = identity?.email?.trim().toLowerCase();
  const allowedEmail = env.MITPAD_WEB_ALLOWED_EMAIL?.trim().toLowerCase();
  if (!identity || !email || !allowedEmail || email !== allowedEmail) {
    throw new ConvexError("Esta cuenta no tiene acceso al workspace de Mitpad.");
  }
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal()))
    .unique();
  if (!workspace) throw new ConvexError("No existe el workspace personal de Mitpad.");
  return { identity, workspace };
}

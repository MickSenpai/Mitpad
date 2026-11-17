import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { hashAgentApiKey } from "./acceso";
import { exigirPropietario, exigirWeb } from "./webAuth";

const MAX_MEMBERS = 10;
const MAX_ACTIVE_INVITES = 10;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const workspaceSummary = v.object({ id: v.id("workspaces"), name: v.string(), role: v.union(v.literal("owner"), v.literal("editor")) });

/** Who is in the current workspace, which workspaces the person can switch to, and pending invitations (owner only). */
export const equipo = query({
  args: {},
  returns: v.object({
    current: workspaceSummary,
    workspaces: v.array(workspaceSummary),
    ownerEmail: v.union(v.string(), v.null()),
    members: v.array(v.object({ userId: v.id("users"), email: v.string(), role: v.literal("editor"), createdAt: v.number() })),
    invites: v.array(v.object({ id: v.id("workspaceInvites"), createdAt: v.number(), expiresAt: v.number() })),
  }),
  handler: async (ctx) => {
    const { workspace, role, userId, ownWorkspaceId } = await exigirWeb(ctx);
    const own = await ctx.db.get(ownWorkspaceId);
    const memberships = await ctx.db.query("workspaceMembers").withIndex("by_userId", (q) => q.eq("userId", userId)).take(50);
    const workspaces: { id: Id<"workspaces">; name: string; role: "owner" | "editor" }[] = own ? [{ id: own._id, name: own.name, role: "owner" }] : [];
    for (const membership of memberships) {
      const shared = await ctx.db.get(membership.workspaceId);
      if (shared) workspaces.push({ id: shared._id, name: shared.name, role: membership.role });
    }
    const ownerId = ctx.db.normalizeId("users", workspace.ownerId);
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    const members = await ctx.db.query("workspaceMembers").withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspace._id)).take(MAX_MEMBERS + 5);
    const now = Date.now();
    const invites = role === "owner"
      ? (await ctx.db.query("workspaceInvites").withIndex("by_workspaceId_and_createdAt", (q) => q.eq("workspaceId", workspace._id)).order("desc").take(50))
          .filter((invite) => invite.usedAt === undefined && invite.expiresAt > now)
          .map((invite) => ({ id: invite._id, createdAt: invite.createdAt, expiresAt: invite.expiresAt }))
      : [];
    return {
      current: { id: workspace._id, name: workspace.name, role },
      workspaces,
      ownerEmail: owner?.email ?? null,
      members: members.map((member) => ({ userId: member.userId, email: member.email, role: member.role, createdAt: member.createdAt })),
      invites,
    };
  },
});

/** Creates a one-time invitation code. The raw code is returned once; only its hash is stored. */
export const crearInvitacion = mutation({
  args: {},
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    const { workspace, userId } = await exigirPropietario(ctx);
    const now = Date.now();
    const recent = await ctx.db.query("workspaceInvites").withIndex("by_workspaceId_and_createdAt", (q) => q.eq("workspaceId", workspace._id)).order("desc").take(50);
    if (recent.filter((invite) => invite.usedAt === undefined && invite.expiresAt > now).length >= MAX_ACTIVE_INVITES) {
      throw new ConvexError("Ya hay demasiadas invitaciones pendientes. Revoca alguna antes de crear otra.");
    }
    const members = await ctx.db.query("workspaceMembers").withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspace._id)).take(MAX_MEMBERS + 1);
    if (members.length >= MAX_MEMBERS) throw new ConvexError(`El workspace alcanzó el máximo de ${MAX_MEMBERS} colaboradores.`);
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const code = `pci_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const expiresAt = now + INVITE_TTL_MS;
    await ctx.db.insert("workspaceInvites", { workspaceId: workspace._id, codeHash: await hashAgentApiKey(code), createdByUserId: userId, createdAt: now, expiresAt });
    return { code, expiresAt };
  },
});

export const revocarInvitacion = mutation({
  args: { inviteId: v.id("workspaceInvites") },
  returns: v.boolean(),
  handler: async (ctx, { inviteId }) => {
    const { workspace } = await exigirPropietario(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.workspaceId !== workspace._id) return false;
    await ctx.db.delete(inviteId);
    return true;
  },
});

/** Redeems an invitation code: the person becomes an editor and switches into that workspace. */
export const aceptarInvitacion = mutation({
  args: { code: v.string() },
  returns: workspaceSummary,
  handler: async (ctx, { code }) => {
    const { userId, identity, ownWorkspaceId, accountId } = await exigirWeb(ctx);
    const cleaned = code.trim();
    if (cleaned.length < 20 || cleaned.length > 64) throw new ConvexError("El código de invitación no es válido.");
    const codeHash = await hashAgentApiKey(cleaned);
    const invite = await ctx.db.query("workspaceInvites").withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash)).unique();
    if (!invite || invite.usedAt !== undefined || invite.expiresAt <= Date.now()) throw new ConvexError("El código de invitación no es válido, ya se usó o venció.");
    if (invite.workspaceId === ownWorkspaceId) throw new ConvexError("Ese workspace ya es tuyo.");
    const workspace = await ctx.db.get(invite.workspaceId);
    if (!workspace) throw new ConvexError("El workspace de esta invitación ya no existe.");
    const existing = await ctx.db.query("workspaceMembers").withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspace._id).eq("userId", userId)).unique();
    if (existing) throw new ConvexError("Ya eres colaborador de ese workspace.");
    const count = await ctx.db.query("workspaceMembers").withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspace._id)).take(MAX_MEMBERS + 1);
    if (count.length >= MAX_MEMBERS) throw new ConvexError("Ese workspace ya alcanzó el máximo de colaboradores.");
    const email = typeof identity.email === "string" && identity.email ? identity.email : "sin correo";
    await ctx.db.insert("workspaceMembers", { workspaceId: workspace._id, userId, email, role: "editor", createdAt: Date.now() });
    await ctx.db.patch(invite._id, { usedAt: Date.now() });
    await ctx.db.patch(accountId, { activeWorkspaceId: workspace._id });
    return { id: workspace._id, name: workspace.name, role: "editor" as const };
  },
});

async function clearActive(ctx: MutationCtx, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  const account = await ctx.db.query("webAccounts").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
  if (account?.activeWorkspaceId === workspaceId) await ctx.db.patch(account._id, { activeWorkspaceId: undefined });
}

export const quitarColaborador = mutation({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, { userId }) => {
    const { workspace } = await exigirPropietario(ctx);
    const member = await ctx.db.query("workspaceMembers").withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspace._id).eq("userId", userId)).unique();
    if (!member) return false;
    await ctx.db.delete(member._id);
    await clearActive(ctx, userId, workspace._id);
    return true;
  },
});

export const salirDelWorkspace = mutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const { workspace, userId, role } = await exigirWeb(ctx);
    if (role === "owner") throw new ConvexError("El propietario no puede salirse de su propio workspace.");
    const member = await ctx.db.query("workspaceMembers").withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspace._id).eq("userId", userId)).unique();
    if (member) await ctx.db.delete(member._id);
    await clearActive(ctx, userId, workspace._id);
    return true;
  },
});

export const cambiarWorkspace = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const { userId, ownWorkspaceId, accountId } = await exigirWeb(ctx);
    if (workspaceId === ownWorkspaceId) { await ctx.db.patch(accountId, { activeWorkspaceId: undefined }); return null; }
    const member = await ctx.db.query("workspaceMembers").withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).unique();
    if (!member) throw new ConvexError("No tienes acceso a ese workspace.");
    await ctx.db.patch(accountId, { activeWorkspaceId: workspaceId });
    return null;
  },
});

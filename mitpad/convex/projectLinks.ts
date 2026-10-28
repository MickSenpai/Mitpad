import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { exigirToken, userIdPersonal } from "./acceso";

const relationType = v.union(v.literal("related_to"), v.literal("parent_of"), v.literal("depends_on"));
const publicLink = (link: Doc<"projectLinks">) => ({
  id: link._id, clientId: link.clientId ?? null, sourceProjectId: link.sourceProjectId,
  targetProjectId: link.targetProjectId, relationType: link.relationType, description: link.description ?? "", createdAt: link.createdAt,
});
const publicLinkValidator = v.object({ id: v.id("projectLinks"), clientId: v.union(v.string(), v.null()), sourceProjectId: v.id("projects"), targetProjectId: v.id("projects"), relationType, description: v.string(), createdAt: v.number() });

export const listar = query({
  args: { token: v.string() },
  returns: v.array(publicLinkValidator),
  handler: async (ctx, { token }) => {
    exigirToken(token);
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", q => q.eq("ownerId", userIdPersonal())).unique();
    if (!workspace) return [];
    const links = await ctx.db.query("projectLinks").withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspace._id)).order("asc").take(1000);
    return links.map(publicLink);
  },
});

export const listarAgente = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(publicLinkValidator),
  handler: async (ctx, { workspaceId }) => {
    const links = await ctx.db.query("projectLinks")
      .withIndex("by_workspaceId_and_createdAt", q => q.eq("workspaceId", workspaceId))
      .order("asc").take(1000);
    return links.map(publicLink);
  },
});

export const crearAgente = internalMutation({
  args: {
    workspaceId: v.id("workspaces"), agentId: v.id("agents"),
    sourceProjectId: v.id("projects"), targetProjectId: v.id("projects"),
    relationType, description: v.optional(v.string()),
  },
  returns: publicLinkValidator,
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent?.active || agent.workspaceId !== args.workspaceId) throw new ConvexError("El agente no pertenece a este workspace o está desactivado.");
    if (args.sourceProjectId === args.targetProjectId) throw new ConvexError("Un proyecto no puede relacionarse consigo mismo.");
    if ((args.description?.length ?? 0) > 1000) throw new ConvexError("La descripción supera 1000 caracteres.");
    const [source, target] = await Promise.all([ctx.db.get(args.sourceProjectId), ctx.db.get(args.targetProjectId)]);
    if (!source || !target || source.workspaceId !== args.workspaceId || target.workspaceId !== args.workspaceId) {
      throw new ConvexError("Ambos proyectos deben pertenecer al workspace del agente.");
    }
    const prior = (await ctx.db.query("projectLinks")
      .withIndex("by_sourceProjectId_and_targetProjectId", q => q.eq("sourceProjectId", args.sourceProjectId).eq("targetProjectId", args.targetProjectId))
      .take(1))[0];
    const now = Date.now();
    if (prior) {
      await ctx.db.patch(prior._id, { relationType: args.relationType, description: args.description?.trim() || undefined });
      await ctx.db.insert("activityEvents", {
        workspaceId: args.workspaceId, projectId: args.sourceProjectId, actorType: "agent", actorId: agent._id,
        eventType: "project_updated", entityType: "project", entityId: args.sourceProjectId,
        summary: `Actualizó la relación entre ${source.name} y ${target.name}`,
        details: args.description?.trim(), createdAt: now,
      });
      return publicLink((await ctx.db.get(prior._id))!);
    }
    const id = await ctx.db.insert("projectLinks", {
      workspaceId: args.workspaceId, sourceProjectId: args.sourceProjectId,
      targetProjectId: args.targetProjectId, relationType: args.relationType,
      description: args.description?.trim() || undefined, createdAt: now,
    });
    await ctx.db.insert("activityEvents", {
      workspaceId: args.workspaceId, projectId: args.sourceProjectId, actorType: "agent", actorId: agent._id,
      eventType: "project_updated", entityType: "project", entityId: args.sourceProjectId,
      summary: `Relacionó ${source.name} con ${target.name}`,
      details: args.description?.trim(), createdAt: now,
    });
    return publicLink((await ctx.db.get(id))!);
  },
});

export const crear = mutation({
  args: { token: v.string(), clientId: v.string(), sourceProjectId: v.id("projects"), targetProjectId: v.id("projects"), relationType, description: v.optional(v.string()) },
  returns: publicLinkValidator,
  handler: async (ctx, args) => {
    exigirToken(args.token);
    if (args.sourceProjectId === args.targetProjectId) throw new ConvexError("Un proyecto no puede relacionarse consigo mismo.");
    if ((args.description?.length ?? 0) > 1000) throw new ConvexError("La descripción de la relación supera 1000 caracteres.");
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", q => q.eq("ownerId", userIdPersonal())).unique();
    if (!workspace) throw new ConvexError("No existe el espacio personal.");
    const [source, target] = await Promise.all([ctx.db.get(args.sourceProjectId), ctx.db.get(args.targetProjectId)]);
    if (!source || !target || source.workspaceId !== workspace._id || target.workspaceId !== workspace._id) throw new ConvexError("Ambos proyectos deben pertenecer al espacio personal.");
    const prior = await ctx.db.query("projectLinks").withIndex("by_workspaceId_and_clientId", q => q.eq("workspaceId", workspace._id).eq("clientId", args.clientId)).unique();
    if (prior) {
      await ctx.db.patch(prior._id, { relationType: args.relationType, description: args.description?.trim() || undefined });
      return publicLink((await ctx.db.get(prior._id))!);
    }
    const same = await ctx.db.query("projectLinks").withIndex("by_sourceProjectId_and_targetProjectId", q => q.eq("sourceProjectId", args.sourceProjectId).eq("targetProjectId", args.targetProjectId)).unique();
    if (same) {
      await ctx.db.patch(same._id, { relationType: args.relationType, description: args.description?.trim() || undefined });
      return publicLink((await ctx.db.get(same._id))!);
    }
    const id = await ctx.db.insert("projectLinks", { workspaceId: workspace._id, clientId: args.clientId, sourceProjectId: args.sourceProjectId, targetProjectId: args.targetProjectId, relationType: args.relationType, description: args.description?.trim() || undefined, createdAt: Date.now() });
    const link = await ctx.db.get(id);
    if (!link) throw new ConvexError("No se pudo guardar la relación.");
    return publicLink(link);
  },
});

export const borrar = mutation({
  args: { token: v.string(), id: v.id("projectLinks") }, returns: v.boolean(),
  handler: async (ctx, { token, id }) => {
    exigirToken(token);
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", q => q.eq("ownerId", userIdPersonal())).unique();
    const link = await ctx.db.get(id);
    if (!workspace || !link || link.workspaceId !== workspace._id) return false;
    await ctx.db.delete(id);
    return true;
  },
});

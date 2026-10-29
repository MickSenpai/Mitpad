import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { env } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { exigirToken, hashAgentApiKey, userIdPersonal } from "./acceso";
import { asegurarWorkspace } from "./workspaces";

const agentPublicValidator = v.object({
  id: v.id("agents"),
  workspaceId: v.id("workspaces"),
  name: v.string(),
  model: v.string(),
  modelProvider: v.string(),
  clientType: v.string(),
  pilot: v.string(),
  active: v.boolean(),
  createdAt: v.number(),
  lastSeenAt: v.union(v.number(), v.null()),
});

function agentePublico(agent: {
  _id: Id<"agents">; workspaceId: Id<"workspaces">; name: string; model: string;
  modelProvider: string; clientType: string; pilot: string; active: boolean;
  createdAt: number; lastSeenAt?: number;
}) {
  return {
    id: agent._id, workspaceId: agent.workspaceId, name: agent.name, model: agent.model,
    modelProvider: agent.modelProvider, clientType: agent.clientType, pilot: agent.pilot,
    active: agent.active, createdAt: agent.createdAt, lastSeenAt: agent.lastSeenAt ?? null,
  };
}

export const registrar = mutation({
  args: {
    token: v.string(), name: v.string(), model: v.string(), modelProvider: v.string(),
    clientType: v.string(), pilot: v.string(),
  },
  returns: v.object({ agent: agentPublicValidator, apiKey: v.string(), instructions: v.string() }),
  handler: async (ctx, args) => {
    exigirToken(args.token);
    for (const [field, value, max] of [
      ["name", args.name, 100], ["model", args.model, 120],
      ["modelProvider", args.modelProvider, 80], ["clientType", args.clientType, 80], ["pilot", args.pilot, 120],
    ] as const) {
      if (!value.trim() || value.length > max) throw new Error(`Campo ${field} inválido.`);
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const apiKey = `pha_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const apiKeyHash = await hashAgentApiKey(apiKey);
    const ownerId = userIdPersonal();
    const workspaceId = await asegurarWorkspace(ctx, ownerId);
    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      workspaceId, name: args.name.trim(), model: args.model.trim(), modelProvider: args.modelProvider.trim(),
      clientType: args.clientType.trim(), pilot: args.pilot.trim(), apiKeyHash, credentialMode: "mcp", active: true, createdAt: now,
    });
    await ctx.db.insert("activityEvents", {
      workspaceId, actorType: "human", actorId: "pilot", eventType: "agent_registered",
      entityType: "agent", entityId: agentId, summary: `Se registró el agente ${args.name.trim()}`, createdAt: now,
    });
    const agent = await ctx.db.get(agentId);
    if (!agent) throw new Error("No se pudo crear el agente.");
    return {
      agent: agentePublico(agent),
      apiKey,
      instructions: `API base: ${env.CONVEX_SITE_URL}/api/v1. Usa Authorization: Bearer ${apiKey}. Lee GET /events?since=<timestamp> para recuperar actividad; usa /projects y /tasks para consultar y actualizar el trabajo.`,
    };
  },
});

export const lista = query({
  args: { token: v.string() },
  returns: v.array(agentPublicValidator),
  handler: async (ctx, { token }) => {
    exigirToken(token);
    const workspace = await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal())).unique();
    if (!workspace) return [];
    const agents = await ctx.db.query("agents").withIndex("by_workspaceId_and_createdAt", (q) => q.eq("workspaceId", workspace._id)).order("desc").take(200);
    return agents.map(agentePublico);
  },
});

export const desactivar = mutation({
  args: { token: v.string(), agentId: v.id("agents") },
  returns: v.boolean(),
  handler: async (ctx, { token, agentId }) => {
    exigirToken(token);
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.workspaceId !== (await ctx.db.query("workspaces").withIndex("by_ownerId", (q) => q.eq("ownerId", userIdPersonal())).unique())?._id) return false;
    if (!agent.active) return true;
    await ctx.db.patch(agentId, { active: false });
    return true;
  },
});

/** Hash-only lookup for the REST layer. Raw API keys are never persisted. */
export const buscarPorHash = internalQuery({
  args: { apiKeyHash: v.string() },
  returns: v.union(v.object({ id: v.id("agents"), workspaceId: v.id("workspaces"), name: v.string(), active: v.boolean() }), v.null()),
  handler: async (ctx, { apiKeyHash }) => {
    const agent = await ctx.db.query("agents").withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", apiKeyHash)).unique();
    return agent ? { id: agent._id, workspaceId: agent.workspaceId, name: agent.name, active: agent.active } : null;
  },
});

/** Record successful API use without exposing the credential. */
export const registrarUso = internalMutation({
  args: { agentId: v.id("agents") },
  returns: v.null(),
  handler: async (ctx, { agentId }) => {
    const agent = await ctx.db.get(agentId);
    const now = Date.now();
    // Agent APIs can be called repeatedly by MCP clients; avoid a write for
    // every tool call while keeping the displayed presence reasonably fresh.
    if (agent?.active && (!agent.lastSeenAt || now - agent.lastSeenAt >= 60_000)) {
      await ctx.db.patch(agentId, { lastSeenAt: now });
    }
    return null;
  },
});

// Keep the import available for typed callers that need an action reference.
void action;

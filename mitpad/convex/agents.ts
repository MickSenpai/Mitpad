import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

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

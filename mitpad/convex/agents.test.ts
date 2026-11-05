/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { hashAgentApiKey, keyFromRequest } from "./acceso";

const modules = import.meta.glob("./**/*.ts");

async function seedAgent(active = true, lastSeenAt?: number) {
  const t = convexTest(schema, modules);
  const apiKey = `pha_${"a".repeat(64)}`;
  const apiKeyHash = await hashAgentApiKey(apiKey);
  const agentId = await t.run(async ({ db }) => {
    const now = Date.now();
    const workspaceId = await db.insert("workspaces", { ownerId: "owner", name: "W", createdAt: now, updatedAt: now });
    return db.insert("agents", {
      workspaceId, name: "Bot", model: "m", modelProvider: "p", clientType: "c", pilot: "me",
      apiKeyHash, active, createdAt: now, ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    });
  });
  return { t, apiKey, apiKeyHash, agentId };
}

describe("agent credentials", () => {
  it("finds an agent by key hash and never by a wrong key", async () => {
    const { t, apiKeyHash, agentId } = await seedAgent();
    expect((await t.query(internal.agents.buscarPorHash, { apiKeyHash }))?.id).toBe(agentId);
    const wrong = await hashAgentApiKey("pha_" + "b".repeat(64));
    expect(await t.query(internal.agents.buscarPorHash, { apiKeyHash: wrong })).toBeNull();
  });

  it("reports deactivated agents as inactive so the HTTP layer rejects them", async () => {
    const { t, apiKeyHash } = await seedAgent(false);
    expect((await t.query(internal.agents.buscarPorHash, { apiKeyHash }))?.active).toBe(false);
  });

  it("throttles lastSeenAt writes to once per minute", async () => {
    const recent = Date.now() - 1000;
    const { t, agentId } = await seedAgent(true, recent);
    await t.mutation(internal.agents.registrarUso, { agentId });
    expect((await t.run((c) => c.db.get(agentId)))?.lastSeenAt).toBe(recent);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(recent + 61_000);
      await t.mutation(internal.agents.registrarUso, { agentId });
    } finally { vi.useRealTimers(); }
    expect((await t.run((c) => c.db.get(agentId)))?.lastSeenAt).toBe(recent + 61_000);
  });

  it("does not record use for inactive agents", async () => {
    const { t, agentId } = await seedAgent(false);
    await t.mutation(internal.agents.registrarUso, { agentId });
    expect((await t.run((c) => c.db.get(agentId)))?.lastSeenAt).toBeUndefined();
  });
});

describe("keyFromRequest", () => {
  const req = (auth?: string) => new Request("https://x.test", auth ? { headers: { Authorization: auth } } : {});
  it("accepts a well-formed bearer key", async () => {
    expect(await keyFromRequest(req(`Bearer ${"k".repeat(40)}`))).toBe("k".repeat(40));
  });
  it("rejects missing, short, oversized and non-bearer credentials", async () => {
    expect(await keyFromRequest(req())).toBeNull();
    expect(await keyFromRequest(req("Bearer short"))).toBeNull();
    expect(await keyFromRequest(req(`Bearer ${"k".repeat(201)}`))).toBeNull();
    expect(await keyFromRequest(req(`Basic ${"k".repeat(40)}`))).toBeNull();
  });
});

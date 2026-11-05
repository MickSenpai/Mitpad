/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { hashAgentApiKey } from "./acceso";

const modules = import.meta.glob("./**/*.ts");

async function seedAgent(t: ReturnType<typeof convexTest>, label: string, active = true) {
  const apiKey = `pha_${label.repeat(64).slice(0, 64)}`;
  const apiKeyHash = await hashAgentApiKey(apiKey);
  const ids = await t.run(async ({ db }) => {
    const now = Date.now();
    const workspaceId = await db.insert("workspaces", { ownerId: `owner-${label}`, name: label, createdAt: now, updatedAt: now });
    const agentId = await db.insert("agents", {
      workspaceId, name: `Bot ${label}`, model: "m", modelProvider: "p", clientType: "c", pilot: "me",
      apiKeyHash, active, createdAt: now,
    });
    return { workspaceId, agentId };
  });
  return { apiKey, ...ids };
}

const call = (t: ReturnType<typeof convexTest>, key: string | null, method: string, path: string, body?: unknown) =>
  t.fetch(path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("agent HTTP API", () => {
  it("answers the health probe without credentials", async () => {
    const t = convexTest(schema, modules);
    const res = await call(t, null, "GET", "/api/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("rejects missing, unknown and deactivated keys with 401", async () => {
    const t = convexTest(schema, modules);
    const off = await seedAgent(t, "a", false);
    expect((await call(t, null, "GET", "/api/v1/projects")).status).toBe(401);
    expect((await call(t, "x".repeat(64), "GET", "/api/v1/projects")).status).toBe(401);
    expect((await call(t, off.apiKey, "GET", "/api/v1/projects")).status).toBe(401);
  });

  it("no longer exposes the shared-token agent registration endpoint", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/v1/agents/register", {
      method: "POST", headers: { Authorization: `Bearer ${"z".repeat(48)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", model: "x", model_provider: "x", client_type: "x", pilot: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("creates and lists projects, validating the body", async () => {
    const t = convexTest(schema, modules);
    const { apiKey } = await seedAgent(t, "b");
    expect((await call(t, apiKey, "POST", "/api/v1/projects", { name: "" })).status).toBe(400);
    expect((await call(t, apiKey, "POST", "/api/v1/projects", { name: 5 })).status).toBe(400);
    const created = await call(t, apiKey, "POST", "/api/v1/projects", { name: "Alpha", description: "d" });
    expect(created.status).toBe(201);
    const list = await (await call(t, apiKey, "GET", "/api/v1/projects")).json();
    expect(JSON.stringify(list)).toContain("Alpha");
  });

  it("returns 404 for unknown routes and 400 for invalid enums", async () => {
    const t = convexTest(schema, modules);
    const { apiKey } = await seedAgent(t, "c");
    expect((await call(t, apiKey, "GET", "/api/v1/nope")).status).toBe(404);
    expect((await call(t, apiKey, "GET", "/api/v1/tasks?status=bogus")).status).toBe(400);
    expect((await call(t, apiKey, "GET", "/api/v1/events?since=abc")).status).toBe(400);
  });

  it("isolates workspaces: one agent cannot see or delete another's project", async () => {
    const t = convexTest(schema, modules);
    const a = await seedAgent(t, "d");
    const b = await seedAgent(t, "e");
    const project = await (await call(t, a.apiKey, "POST", "/api/v1/projects", { name: "Private" })).json() as { id: string };

    const listB = await (await call(t, b.apiKey, "GET", "/api/v1/projects")).json();
    expect(JSON.stringify(listB)).not.toContain("Private");

    const del = await call(t, b.apiKey, "DELETE", `/api/v1/projects/${project.id}`);
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect(await t.run((c) => c.db.get(project.id as never))).not.toBeNull();
  });
});

describe("project deletion cascade", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("removes tasks, comments and links across batches and keeps other projects", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, agentId } = await seedAgent(t, "f");
    const { doomed, kept } = await t.run(async ({ db }) => {
      const now = Date.now();
      const mk = (name: string) => db.insert("projects", {
        workspaceId, name, description: "", status: "active", createdByType: "human", createdById: "t", createdAt: now, updatedAt: now,
      });
      const doomed = await mk("Doomed");
      const kept = await mk("Kept");
      let firstTask;
      for (let i = 0; i < 230; i++) {
        const id = await db.insert("tasks", {
          workspaceId, projectId: doomed, title: `t${i}`, description: "", status: "todo", priority: "low",
          createdByType: "human", createdById: "t", createdAt: i, updatedAt: i,
        });
        firstTask ??= id;
      }
      await db.insert("taskComments", {
        workspaceId, projectId: doomed, taskId: firstTask!, authorType: "human", authorId: "t", kind: "message", content: "hi", createdAt: now,
      });
      await db.insert("tasks", {
        workspaceId, projectId: kept, title: "survivor", description: "", status: "todo", priority: "low",
        createdByType: "human", createdById: "t", createdAt: now, updatedAt: now,
      });
      await db.insert("projectLinks", { workspaceId, sourceProjectId: doomed, targetProjectId: kept, relationType: "related_to", createdAt: now });
      await db.insert("projectLinks", { workspaceId, sourceProjectId: kept, targetProjectId: doomed, relationType: "depends_on", createdAt: now });
      return { doomed, kept };
    });

    const result = await t.mutation(internal.workbench.borrarProyectoAgente, { workspaceId, agentId, projectId: doomed });
    expect(result).toEqual({ deleted: false, projectName: "Doomed" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await t.run(async ({ db }) => ({
      project: await db.get(doomed),
      keptProject: await db.get(kept),
      tasks: await db.query("tasks").collect(),
      comments: await db.query("taskComments").collect(),
      links: await db.query("projectLinks").collect(),
      jobs: await db.query("projectDeletionJobs").collect(),
    }));
    expect(after.project).toBeNull();
    expect(after.keptProject).not.toBeNull();
    expect(after.tasks.map((x) => x.title)).toEqual(["survivor"]);
    expect(after.comments).toHaveLength(0);
    expect(after.links).toHaveLength(0);
    expect(after.jobs).toHaveLength(0);
  });
});

/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
type DashboardPage = FunctionReturnType<typeof api.web.dashboardPage>;
type TaskSearchPage = FunctionReturnType<typeof api.web.buscarTareas>;
type TaskCommentsPage = FunctionReturnType<typeof api.web.comentariosTarea>;

async function authenticatedWorkspace() {
  const t = convexTest(schema, modules);
  const { userId, workspaceId } = await t.run(async ({ db }) => {
    const userId = await db.insert("users", { email: "pagination@example.test" });
    const now = Date.now();
    const workspaceId = await db.insert("workspaces", {
      ownerId: userId,
      name: "Pagination test",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert("webAccounts", {
      tokenIdentifier: "pagination-test|session",
      userId,
      workspaceId,
      createdAt: now,
    });
    return { userId, workspaceId };
  });
  return {
    t: t.withIdentity({
      subject: `${userId}|session`,
      tokenIdentifier: "pagination-test|session",
      issuer: "https://pagination.example.test",
    }),
    workspaceId,
  };
}

describe("Convex dashboard pagination", () => {
  it("returns every task across cursor pages without duplicates", async () => {
    const { t, workspaceId } = await authenticatedWorkspace();
    const projectId = await t.run(async ({ db }) => db.insert("projects", {
      workspaceId,
      name: "Pagination project",
      description: "",
      status: "active",
      createdByType: "human",
      createdById: "test",
      createdAt: 1,
      updatedAt: 1,
    }));
    const expected = await t.run(async ({ db }) => {
      const ids = [];
      for (let index = 0; index < 235; index++) {
        ids.push(await db.insert("tasks", {
          workspaceId,
          projectId,
          title: `Task ${index}`,
          description: "",
          status: "todo",
          priority: "medium",
          createdByType: "human",
          createdById: "test",
          createdAt: index,
          updatedAt: index,
        }));
      }
      return ids;
    });

    const snapshot = await t.query(api.web.dashboard, {});
    expect(snapshot.tasks).toHaveLength(100);
    expect(snapshot.tasks[0]?.title).toBe("Task 234");

    const actual = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: DashboardPage = await t.query(api.web.dashboardPage, {
        section: "tasks",
        paginationOpts: { numItems: 100, cursor },
      });
      actual.push(...page.items.map(item => item.id));
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    expect(actual).toHaveLength(expected.length);
    expect(new Set(actual).size).toBe(expected.length);
    expect(new Set(actual)).toEqual(new Set(expected));
  });

  it("finds tasks by title and description through the server search indexes", async () => {
    const { t, workspaceId } = await authenticatedWorkspace();
    const projectId = await t.run(async ({ db }) => db.insert("projects", {
      workspaceId,
      name: "Search project",
      description: "",
      status: "active",
      createdByType: "human",
      createdById: "test",
      createdAt: 1,
      updatedAt: 1,
    }));
    await t.run(async ({ db }) => {
      for (let index = 0; index < 130; index++) {
        await db.insert("tasks", {
          workspaceId,
          projectId,
          title: index < 65 ? `needle title ${index}` : `ordinary title ${index}`,
          description: index >= 65 ? `needle description ${index}` : "ordinary description",
          status: "todo",
          priority: "medium",
          createdByType: "human",
          createdById: "test",
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    const collect = async (field: "title" | "description") => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let isDone = false;
      while (!isDone) {
        const page: TaskSearchPage = await t.query(api.web.buscarTareas, {
          text: "needle",
          field,
          paginationOpts: { numItems: 50, cursor },
        });
        ids.push(...page.items.map(item => item.id));
        cursor = page.continueCursor;
        isDone = page.isDone;
      }
      return ids;
    };

    const titleIds = await collect("title");
    const descriptionIds = await collect("description");
    expect(titleIds).toHaveLength(65);
    expect(new Set(titleIds).size).toBe(65);
    expect(descriptionIds).toHaveLength(65);
    expect(new Set(descriptionIds).size).toBe(65);
  });

  it("loads a task conversation beyond the initial 100 comments", async () => {
    const { t, workspaceId } = await authenticatedWorkspace();
    const { taskId, expected } = await t.run(async ({ db }) => {
      const projectId = await db.insert("projects", {
        workspaceId,
        name: "Conversation project",
        description: "",
        status: "active",
        createdByType: "human",
        createdById: "test",
        createdAt: 1,
        updatedAt: 1,
      });
      const taskId = await db.insert("tasks", {
        workspaceId,
        projectId,
        title: "Long conversation",
        description: "",
        status: "todo",
        priority: "medium",
        createdByType: "human",
        createdById: "test",
        createdAt: 1,
        updatedAt: 1,
      });
      const expected = [];
      for (let index = 0; index < 235; index++) {
        expected.push(await db.insert("taskComments", {
          workspaceId,
          projectId,
          taskId,
          authorType: "human",
          authorId: "test",
          kind: "message",
          content: `Comment ${index}`,
          createdAt: index,
        }));
      }
      return { taskId, expected };
    });

    const actual = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: TaskCommentsPage = await t.query(api.web.comentariosTarea, {
        taskId,
        paginationOpts: { numItems: 100, cursor },
      });
      actual.push(...page.items.map(item => item.id));
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    expect(actual).toHaveLength(expected.length);
    expect(new Set(actual)).toEqual(new Set(expected));
  });
});

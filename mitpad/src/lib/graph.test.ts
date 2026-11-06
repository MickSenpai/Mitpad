import { describe, expect, it } from "vitest";
import { buildGraphLinks, buildGraphNodes } from "./graph";

const projects = [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }];
const tasks = [{ id: "t1", projectId: "p1", title: "T", status: "todo" }, { id: "t2", projectId: "p2", title: "U", status: "done" }];
const knowledge = [{ id: "k1", projectId: "p1", title: "K", kind: "module" as const, summary: "s", source: "src", tags: ["a"] }];

describe("buildGraphNodes", () => {
  it("shows only projects on a ring when nothing is selected", () => {
    const nodes = buildGraphNodes(projects, tasks, knowledge, "");
    expect(nodes.map((n) => n.kind)).toEqual(["project", "project"]);
    for (const n of nodes) expect(Math.hypot(n.x, n.z)).toBeCloseTo(360);
  });
  it("centres the selected project and adds only its tasks and knowledge", () => {
    const nodes = buildGraphNodes(projects, tasks, knowledge, "p1");
    expect(nodes.map((n) => n.id)).toEqual(["p1", "task:t1", "knowledge:k1"]);
    expect(nodes[0]).toMatchObject({ x: 0, z: 0 });
    expect(nodes[1]).toMatchObject({ status: "todo" });
    expect(nodes[2]).toMatchObject({ knowledgeKind: "module", tags: ["a"] });
  });
  it("returns nothing for an unknown selection", () => {
    expect(buildGraphNodes(projects, tasks, knowledge, "missing")).toEqual([]);
  });
});

describe("buildGraphLinks", () => {
  it("maps camelCase rows to the snake_case shape the graph expects", () => {
    expect(buildGraphLinks([{ sourceProjectId: "a", targetProjectId: "b", description: "d" }]))
      .toEqual([{ source_project_id: "a", target_project_id: "b", description: "d" }]);
  });
  it("keeps the relation type so the map can tell dependencies from plain relations", () => {
    expect(buildGraphLinks([{ sourceProjectId: "a", targetProjectId: "b", relationType: "depends_on" }])[0])
      .toMatchObject({ relation_type: "depends_on" });
  });
});

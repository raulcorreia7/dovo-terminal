import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Project, TaskSummary } from "@dovo-terminal/protocol/workspace.ts";
import { buildRows, rowKey } from "../src/task-rows.ts";

function project(id: string, name: string): Project {
  return { id, name, path: `/${name}`, branch: "main" } as Project;
}

function task(id: string, projectId: string, updatedAt: number, status = "idle"): TaskSummary {
  return {
    id,
    projectId,
    title: `task ${id}`,
    status,
    provider: "codex",
    updatedAt,
  } as TaskSummary;
}

const projects = [project("p1", "website"), project("p2", "api"), project("p3", "empty")];
const tasks = [
  task("a", "p1", 100),
  task("b", "p2", 300, "running"),
  task("c", "p2", 200, "waiting"),
  task("d", "ghost", 50),
];
const keys = (rows: ReturnType<typeof buildRows>) => rows.map(rowKey);

describe("buildRows", () => {
  it("groups tasks under projects, most recently active project first, empty last", () => {
    assert.deepEqual(keys(buildRows(projects, tasks, { collapsed: new Set(), query: "" })), [
      "project:p2",
      "b",
      "c",
      "project:p1",
      "a",
      "project:ghost",
      "d",
      "project:p3",
    ]);
  });

  it("counts running and waiting tasks on the header", () => {
    const [header] = buildRows(projects, tasks, { collapsed: new Set(), query: "" });

    assert.equal(header?.kind, "project");
    assert.deepEqual(
      header?.kind === "project" && [header.total, header.running, header.waiting],
      [2, 1, 1],
    );
  });

  it("hides the tasks of a collapsed project but keeps its header", () => {
    assert.deepEqual(keys(buildRows(projects, tasks, { collapsed: new Set(["p2"]), query: "" })), [
      "project:p2",
      "project:p1",
      "a",
      "project:ghost",
      "d",
      "project:p3",
    ]);
  });

  it("a filter searches every project, folded or not, as a flat list", () => {
    const rows = buildRows(projects, tasks, { collapsed: new Set(["p2"]), query: "api" });

    assert.deepEqual(keys(rows).sort(), ["b", "c"]);
  });

  it("a filter can match the project name", () => {
    const rows = buildRows(projects, tasks, { collapsed: new Set(), query: "website" });

    assert.deepEqual(keys(rows), ["a"]);
  });
});

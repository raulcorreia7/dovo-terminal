import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GOAL_CHARS, MAX_STEPS, stages, validatePlan } from "../src/plan.ts";

const workers = ["a", "b"];
const step = (id: string, extra: object = {}) => ({ id, worker: "a", goal: `do ${id}`, ...extra });
const problem = (raw: unknown) => {
  try {
    validatePlan(raw, workers);

    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("validatePlan", () => {
  it("accepts a small plan and fills in no dependencies", () => {
    const plan = validatePlan({ steps: [step("one")] }, workers);

    assert.deepEqual(plan.steps[0]?.dependsOn, []);
  });

  it("rejects anything that is not a plan, or has extra fields", () => {
    assert.ok(String(problem("nonsense")).includes("not valid"));
    assert.ok(String(problem({ steps: [] })).includes("not valid"));
    assert.ok(String(problem({ steps: [step("one", { run: "rm -rf /" })] })).includes("not valid"));
  });

  it("rejects too many steps and over-long goals", () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, index) => step(`s${index}`));

    assert.ok(String(problem({ steps: many })).includes("not valid"));
    assert.ok(
      problem({ steps: [{ ...step("one"), goal: "x".repeat(MAX_GOAL_CHARS + 1) }] }).includes(
        "not valid",
      ),
    );
  });

  it("rejects an unknown worker, duplicate ids, and bad dependencies", () => {
    assert.ok(
      String(problem({ steps: [step("one", { worker: "ghost" })] })).includes(
        'unknown worker "ghost"',
      ),
    );
    assert.ok(String(problem({ steps: [step("one"), step("one")] })).includes("unique"));
    assert.ok(
      String(problem({ steps: [step("one", { dependsOn: ["two"] })] })).includes(
        "not another step",
      ),
    );
    assert.ok(
      String(problem({ steps: [step("one", { dependsOn: ["one"] })] })).includes(
        "not another step",
      ),
    );
  });

  it("rejects a circle of dependencies", () => {
    const circle = {
      steps: [step("one", { dependsOn: ["two"] }), step("two", { dependsOn: ["one"] })],
    };

    assert.ok(String(problem(circle)).includes("circle"));
  });
});

describe("stages", () => {
  it("groups independent steps together and dependent ones after", () => {
    const plan = validatePlan(
      { steps: [step("one"), step("two"), step("three", { dependsOn: ["one", "two"] })] },
      workers,
    );

    assert.deepEqual(
      stages(plan).map((level) => level.map((each) => each.id)),
      [["one", "two"], ["three"]],
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePlan } from "../src/plan.ts";
import { extractJson, singleWorker } from "../src/planner.ts";

const NO_PLAN = /did not return a JSON plan/u;

describe("singleWorker", () => {
  it("makes a valid one-step plan from the whole goal", async () => {
    const proposed = await singleWorker("box")("fix the nav", ["box"]);

    assert.deepEqual(validatePlan(proposed, ["box"]).steps[0]?.goal, "fix the nav");
  });
});

describe("extractJson", () => {
  it("reads a bare object", () => {
    assert.deepEqual(extractJson('{"steps":[]}'), { steps: [] });
  });

  it("finds the object inside prose and code fences", () => {
    const wrapped = [
      "Sure! Here is the plan:",
      "```json",
      '{"steps":[{"id":"a"}]}',
      "```",
      "Hope it helps {not json}",
    ].join("\n");

    assert.deepEqual(extractJson(wrapped), { steps: [{ id: "a" }] });
  });

  it("refuses when there is no JSON at all", () => {
    assert.throws(() => extractJson("no plan here"), NO_PLAN);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import { deepChecks } from "../src/deep.ts";

describe("deepChecks", () => {
  it("asks each expected agent once and removes its throwaway task", async () => {
    const client = createDemoClient();
    const before = (await client.listTasks()).length;

    const checks = await deepChecks([{ name: "laptop", client, expect: ["codex", "claude"] }]);

    assert.deepEqual(
      checks.map((check) => [check.name, check.ok]),
      [
        ["try Codex", true],
        ["try Claude", true],
      ],
    );
    assert.equal((await client.listTasks()).length, before, "no clutter left behind");
  });

  it("does nothing costly without a list of agents to try, and says how to fix that", async () => {
    const client = createDemoClient();

    const checks = await deepChecks([{ name: "laptop", client, expect: [] }]);

    assert.equal(checks[0]?.ok, false);
    assert.ok(checks[0]?.next?.includes("expect"));
    assert.equal((await client.listTasks()).length, 1, "no task was created");
  });

  it("skips an agent the machine does not offer", async () => {
    const checks = await deepChecks([
      { name: "laptop", client: createDemoClient(), expect: ["ghost"] },
    ]);

    assert.deepEqual(checks, []);
  });

  it("reports a machine that cannot even list its projects", async () => {
    const broken = { ...createDemoClient(), listProjects: () => Promise.reject(new Error("down")) };

    const checks = await deepChecks([
      { name: "laptop", client: broken as never, expect: ["codex"] },
    ]);

    assert.equal(checks[0]?.ok, false);
    assert.equal(checks[0]?.detail, "down");
  });
});

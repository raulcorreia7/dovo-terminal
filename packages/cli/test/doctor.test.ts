import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import { runChecks, type Target } from "../src/doctor.ts";

const START_RUNTIME = /start the runtime/u;
const ONE_ARCHIVED = /1 archived task/u;
const deps = { fetchCard: () => Promise.resolve(true), now: () => Date.now() };
const find = (checks: Awaited<ReturnType<typeof runChecks>>, name: string) =>
  checks.find((check) => check.name === name);

function demoTarget(overrides: Partial<Target> = {}): Target {
  return { name: "laptop", client: createDemoClient(), expect: [], ...overrides };
}

describe("runChecks", () => {
  it("passes a healthy machine", async () => {
    const checks = await runChecks([demoTarget()], deps);

    assert.ok(
      checks.every((check) => check.ok),
      JSON.stringify(checks),
    );
    assert.equal(find(checks, "runtime")?.detail, "2 project(s)");
  });

  it("names the harnesses that are expected but missing", async () => {
    const checks = await runChecks([demoTarget({ expect: ["codex", "opencode", "ghost"] })], deps);
    const agents = find(checks, "agents");

    assert.equal(agents?.ok, false);
    assert.equal(agents?.detail, "missing: ghost");
    assert.ok(agents?.next);
  });

  it("matches a harness by id or by label, case-insensitively", async () => {
    const checks = await runChecks([demoTarget({ expect: ["CODEX", "pi"] })], deps);

    assert.equal(find(checks, "agents")?.ok, true);
  });

  it("reports an unreachable runtime with a next step, and skips the rest for it", async () => {
    const broken = {
      listProjects: () => Promise.reject(new Error("runtime unreachable")),
      listProviders: () => Promise.reject(new Error("unused")),
    };
    const checks = await runChecks([demoTarget({ client: broken })], deps);

    assert.equal(find(checks, "runtime")?.ok, false);
    assert.match(find(checks, "runtime")?.next ?? "", START_RUNTIME);
    assert.equal(find(checks, "agents"), undefined);
  });

  it("checks one machine without letting another's failure hide it", async () => {
    const down = { ...createDemoClient(), listProjects: () => Promise.reject(new Error("down")) };
    const checks = await runChecks(
      [demoTarget({ name: "a" }), demoTarget({ name: "b", client: down as never })],
      deps,
    );

    assert.equal(
      checks.filter((check) => check.machine === "a").every((check) => check.ok),
      true,
    );
    assert.equal(
      checks.some((check) => check.machine === "b" && !check.ok),
      true,
    );
  });

  it("reports a tunnel that is not up, and an agent card that is not reachable", async () => {
    const checks = await runChecks([demoTarget({ tunnel: "down", a2aUrl: "http://127.0.0.1:1" })], {
      ...deps,
      fetchCard: () => Promise.resolve(false),
    });

    assert.equal(find(checks, "tunnel")?.ok, false);
    assert.equal(find(checks, "a2a")?.ok, false);
  });

  it("counts archived tasks old enough to prune", async () => {
    const client = createDemoClient();
    await client.setTaskArchived("t-old", true);
    const checks = await runChecks([demoTarget({ client })], {
      ...deps,
      now: () => Date.now() + 40 * 24 * 3_600_000,
    });

    assert.match(find(checks, "cleanup")?.detail ?? "", ONE_ARCHIVED);
  });
});

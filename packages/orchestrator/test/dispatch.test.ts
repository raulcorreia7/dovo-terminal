import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SyncFrame } from "@dovo-terminal/protocol/sync.ts";
import { SyncSink } from "@dovo-terminal/protocol/sync-sink.ts";
import type { TaskSummary } from "@dovo-terminal/protocol/workspace.ts";
import { runPlan, type Worker } from "../src/dispatch.ts";
import { validatePlan } from "../src/plan.ts";

type Script = "done" | "fail" | "ask" | "hang" | "throw";

/** A scripted worker: each delegated task ends the way its script says. */
function scripted(name: string, script: Script, log: string[]) {
  const sink = new SyncSink();
  let counter = 0;
  const stopped: string[] = [];
  const emit = (frame: SyncFrame) => sink.publish(frame);
  const worker: Worker = {
    subscribe: (next) => sink.subscribe(next),
    stopTask(taskId) {
      stopped.push(taskId);

      return Promise.resolve();
    },
    delegate(prompt, metadata) {
      if (script === "throw") {
        return Promise.reject(new Error("worker unreachable"));
      }
      counter += 1;
      const id = `${name}-${counter}`;
      log.push(`${name}:${prompt.split("\n")[0]}|hops=${String(metadata?.["hops"])}`);
      const say = (text: string) =>
        emit({
          type: "event",
          event: {
            type: "item.append",
            taskId: id,
            item: { kind: "assistant", id: `${id}-m`, text, done: true },
          },
        });
      const status = (value: "idle" | "error" | "waiting") =>
        emit({ type: "event", event: { type: "status", taskId: id, status: value } });
      queueMicrotask(() => {
        if (script === "done") {
          say(`${name} finished`);
          status("idle");
        } else if (script === "fail") {
          status("error");
        } else if (script === "ask") {
          status("waiting");
        }
      });

      return Promise.resolve({ id } as TaskSummary);
    },
  };

  return { worker, stopped };
}

const ANSWER_ELSEWHERE = /answer it on that worker/u;
const UNREACHABLE = /unreachable/u;

const plan = (steps: object[]) => validatePlan({ steps }, ["a", "b", "c"]);

describe("runPlan", () => {
  it("runs steps and returns each worker's answer", async () => {
    const log: string[] = [];
    const { worker } = scripted("a", "done", log);

    const results = await runPlan(
      plan([{ id: "one", worker: "a", goal: "build" }]),
      { a: worker },
      { hops: 0 },
    );

    assert.equal(results[0]?.state, "done");
    assert.equal(results[0]?.text, "a finished");
  });

  it("passes the hop count on, one deeper, so a loop of orchestrators ends", async () => {
    const log: string[] = [];
    const { worker } = scripted("a", "done", log);

    await runPlan(plan([{ id: "one", worker: "a", goal: "go" }]), { a: worker }, { hops: 2 });

    assert.ok(log[0]?.endsWith("hops=3"));
  });

  it("feeds earlier results to later steps as data, and skips steps whose dependency failed", async () => {
    const log: string[] = [];
    const a = scripted("a", "done", log);
    const b = scripted("b", "fail", log);
    const c = scripted("c", "done", log);

    const results = await runPlan(
      plan([
        { id: "one", worker: "a", goal: "first" },
        { id: "two", worker: "b", goal: "second", dependsOn: ["one"] },
        { id: "three", worker: "c", goal: "third", dependsOn: ["two"] },
      ]),
      { a: a.worker, b: b.worker, c: c.worker },
      { hops: 0 },
    );

    assert.deepEqual(
      results.map((result) => result.state),
      ["done", "failed", "skipped"],
    );
    assert.equal(log.length, 2, "the skipped step never started");
  });

  it("reports a step that needs input and does not answer it", async () => {
    const log: string[] = [];
    const { worker } = scripted("a", "ask", log);

    const results = await runPlan(
      plan([{ id: "one", worker: "a", goal: "go" }]),
      { a: worker },
      { hops: 0 },
    );

    assert.equal(results[0]?.state, "needs-input");
    assert.match(results[0]?.text ?? "", ANSWER_ELSEWHERE);
  });

  it("does not retry a failed step", async () => {
    const log: string[] = [];
    const { worker } = scripted("a", "fail", log);

    await runPlan(plan([{ id: "one", worker: "a", goal: "go" }]), { a: worker }, { hops: 0 });

    assert.equal(log.length, 1);
  });

  it("turns an unreachable worker into a failed step instead of throwing", async () => {
    const { worker } = scripted("a", "throw", []);

    const results = await runPlan(
      plan([{ id: "one", worker: "a", goal: "go" }]),
      { a: worker },
      { hops: 0 },
    );

    assert.equal(results[0]?.state, "failed");
    assert.match(results[0]?.text ?? "", UNREACHABLE);
  });

  it("runs steps on different workers together but on one worker one at a time", async () => {
    const order: string[] = [];
    const slow = (name: string): Worker => {
      const sink = new SyncSink();
      return {
        subscribe: (next) => sink.subscribe(next),
        stopTask: () => Promise.resolve(),
        delegate(prompt) {
          const id = `${name}-${prompt}`;
          order.push(`start ${prompt}`);
          setTimeout(() => {
            order.push(`end ${prompt}`);
            sink.publish({ type: "event", event: { type: "status", taskId: id, status: "idle" } });
          }, 20);
          return Promise.resolve({ id } as TaskSummary);
        },
      };
    };
    await runPlan(
      plan([
        { id: "s1", worker: "a", goal: "A1" },
        { id: "s2", worker: "a", goal: "A2" },
        { id: "s3", worker: "b", goal: "B1" },
      ]),
      { a: slow("a"), b: slow("b") },
      { hops: 0 },
    );

    assert.ok(order.indexOf("end A1") < order.indexOf("start A2"), "same worker: one at a time");
    assert.ok(order.indexOf("start B1") < order.indexOf("end A1"), "other worker: in parallel");
  });

  it("stops the running task when cancelled", async () => {
    const log: string[] = [];
    const { worker, stopped } = scripted("a", "hang", log);
    const controller = new AbortController();

    const running = runPlan(
      plan([{ id: "one", worker: "a", goal: "go" }]),
      { a: worker },
      { hops: 0, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const results = await running;

    assert.equal(results[0]?.state, "cancelled");
    assert.deepEqual(stopped, ["a-1"]);
  });
});

describe("runPlan, resuming an earlier run", () => {
  const one = () => plan([{ id: "one", worker: "a", goal: "build" }]);

  /** A worker that must not be asked to start anything; it only reports on old tasks. */
  function reporting(statuses: ("running" | "idle" | "waiting" | "error")[]) {
    const log: string[] = [];
    const worker: Worker = {
      subscribe: () => () => undefined,
      stopTask: () => Promise.resolve(),
      delegate: () => {
        log.push("delegated");

        return Promise.reject(new Error("must not start a new task"));
      },
      getTaskHistory: () => {
        const status = statuses.length > 1 ? (statuses.shift() ?? "idle") : (statuses[0] ?? "idle");

        return Promise.resolve({
          status,
          items: [{ kind: "assistant" as const, id: "m", text: "earlier answer", done: true }],
        });
      },
    };

    return { worker, log };
  }

  it("keeps the result of a step that already finished, and starts nothing", async () => {
    const { worker, log } = reporting(["idle"]);
    const resume = new Map([["one", { workerTaskId: "w-1", state: "done", text: "built it" }]]);

    const results = await runPlan(one(), { a: worker }, { hops: 0, resume });

    assert.equal(results[0]?.state, "done");
    assert.equal(results[0]?.text, "built it");
    assert.deepEqual(log, []);
  });

  it("looks at a step that had started instead of starting it again", async () => {
    const { worker, log } = reporting(["idle"]);
    const resume = new Map([["one", { workerTaskId: "w-1", state: null, text: null }]]);

    const results = await runPlan(one(), { a: worker }, { hops: 0, resume });

    assert.equal(results[0]?.state, "done");
    assert.equal(results[0]?.text, "earlier answer");
    assert.deepEqual(log, []);
  });

  it("waits for a resumed task that is still running", async () => {
    const { worker } = reporting(["running", "running", "idle"]);
    const resume = new Map([["one", { workerTaskId: "w-1", state: null, text: null }]]);

    const results = await runPlan(one(), { a: worker }, { hops: 0, resume, pollMs: 5 });

    assert.equal(results[0]?.state, "done");
  });

  it("re-checks a step that was waiting for input: the person may have answered it", async () => {
    const { worker } = reporting(["idle"]);
    const resume = new Map([["one", { workerTaskId: "w-1", state: "needs-input", text: "asked" }]]);

    const results = await runPlan(one(), { a: worker }, { hops: 0, resume });

    assert.equal(results[0]?.state, "done");
  });

  it("says so when the worker cannot report on an old task", async () => {
    const { worker } = scripted("a", "done", []);
    const resume = new Map([["one", { workerTaskId: "w-1", state: null, text: null }]]);

    const results = await runPlan(one(), { a: worker }, { hops: 0, resume });

    assert.equal(results[0]?.state, "failed");
    assert.ok(String(results[0]?.text ?? "").includes("after a restart"));
  });

  it("tells the caller each worker task as soon as it exists, before it finishes", async () => {
    const log: string[] = [];
    const { worker } = scripted("a", "done", log);
    const started: string[] = [];

    await runPlan(
      one(),
      { a: worker },
      {
        hops: 0,
        onStarted: (stepId, taskId) => {
          started.push(`${stepId}=${taskId}`);
        },
      },
    );

    assert.deepEqual(started, ["one=a-1"]);
  });
});

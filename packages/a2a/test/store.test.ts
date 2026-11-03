import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import { WorkerStore } from "../src/store.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "dovo-store-")), "worker.db");

const task = (id: string, state: TaskState, at: string, contextId = "c1"): Task => ({
  id,
  contextId,
  status: { state, message: undefined, timestamp: at },
  artifacts: [],
  history: [],
  metadata: undefined,
});

const noContext = {} as never;

describe("WorkerStore", () => {
  it("remembers runs, messages and plans across a reopen", async () => {
    const path = dbPath();
    const first = await WorkerStore.open(path);
    await first.beginRun("t1");
    assert.deepEqual(await first.runOf("t1"), { dovoTaskId: null });
    await first.attachRun("t1", "dovo-9");
    await first.recordMessage("m1", "t1");
    await first.savePlan("t1", '{"steps":[]}');
    await first.close();

    const second = await WorkerStore.open(path);

    assert.deepEqual(await second.runOf("t1"), { dovoTaskId: "dovo-9" });
    assert.equal(await second.taskOfMessage("m1"), "t1");
    assert.equal(await second.loadPlan("t1"), '{"steps":[]}');
    assert.equal(await second.runOf("nope"), undefined);
    await second.close();
  });

  it("does not overwrite a message, plan or run that already exists", async () => {
    const store = await WorkerStore.open(dbPath());
    await store.recordMessage("m1", "first");
    await store.recordMessage("m1", "second");
    await store.savePlan("t", "one");
    await store.savePlan("t", "two");
    await store.beginRun("t");
    await store.attachRun("t", "dovo-1");
    await store.beginRun("t");

    assert.equal(await store.taskOfMessage("m1"), "first");
    assert.equal(await store.loadPlan("t"), "one");
    assert.deepEqual(await store.runOf("t"), { dovoTaskId: "dovo-1" });
    await store.close();
  });

  it("merges a step's progress: the task id first, the outcome later", async () => {
    const store = await WorkerStore.open(dbPath());
    await store.saveStep("t", "one", { workerTaskId: "w-1" });
    await store.saveStep("t", "one", { state: "done", text: "ok" });
    await store.saveStep("other", "one", { state: "failed" });

    const steps = await store.loadSteps("t");

    assert.deepEqual(steps.get("one"), { workerTaskId: "w-1", state: "done", text: "ok" });
    assert.equal(steps.size, 1, "another task's steps are not mixed in");
    await store.close();
  });
});

describe("the SDK task store", () => {
  it("saves, updates and loads whole tasks", async () => {
    const store = await WorkerStore.open(dbPath());
    const tasks = store.taskStore();
    await tasks.save(task("t1", TaskState.TASK_STATE_WORKING, "2026-01-01"), noContext);
    await tasks.save(task("t1", TaskState.TASK_STATE_COMPLETED, "2026-01-02"), noContext);

    const loaded = await tasks.load("t1", noContext);

    assert.equal(loaded?.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(await tasks.load("missing", noContext), undefined);
    await store.close();
  });

  it("lists newest first, filtered and in pages", async () => {
    const store = await WorkerStore.open(dbPath());
    const tasks = store.taskStore();
    await tasks.save(task("a", TaskState.TASK_STATE_COMPLETED, "2026-01-01"), noContext);
    await tasks.save(task("b", TaskState.TASK_STATE_WORKING, "2026-01-02"), noContext);
    await tasks.save(task("c", TaskState.TASK_STATE_COMPLETED, "2026-01-03", "c2"), noContext);
    const base = {
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: "",
      statusTimestampAfter: undefined,
    };

    const page = await tasks.list({ ...base, pageSize: 2 }, noContext);
    const rest = await tasks.list(
      { ...base, pageSize: 2, pageToken: page.nextPageToken },
      noContext,
    );
    const done = await tasks.list({ ...base, status: TaskState.TASK_STATE_COMPLETED }, noContext);
    const inContext = await tasks.list({ ...base, contextId: "c2" }, noContext);

    assert.deepEqual(
      page.tasks.map((each) => each.id),
      ["c", "b"],
    );
    assert.deepEqual(
      rest.tasks.map((each) => each.id),
      ["a"],
    );
    assert.equal(rest.nextPageToken, "");
    assert.equal(page.totalSize, 3);
    assert.deepEqual(
      done.tasks.map((each) => each.id),
      ["c", "a"],
    );
    assert.deepEqual(
      inContext.tasks.map((each) => each.id),
      ["c"],
    );
    await store.close();
  });
});

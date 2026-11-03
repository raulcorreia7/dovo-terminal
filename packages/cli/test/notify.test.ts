import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SyncFrame, SyncListener } from "@dovo-terminal/protocol/sync.ts";
import type { TaskStatus, TaskSummary } from "@dovo-terminal/protocol/workspace.ts";
import { describeChange, isSafeWebhook, startTeamsNotifier, teamsPayload } from "../src/notify.ts";

function fakeClient(title: string) {
  let listener: SyncListener = () => undefined;
  const task = { id: "t1", title } as TaskSummary;

  return {
    emit(status: TaskStatus) {
      const frame: SyncFrame = { type: "event", event: { type: "status", taskId: "t1", status } };
      listener(frame);
    },
    client: {
      subscribe(next: SyncListener) {
        listener = next;

        return () => undefined;
      },
      listTasks: () => Promise.resolve([task]),
    },
  };
}

const TEXT_FIELD = /"text":"hello"/u;

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("describeChange", () => {
  it("speaks up when a task starts waiting, once", () => {
    assert.equal(describeChange("running", "waiting"), "needs your input");
    assert.equal(describeChange("waiting", "waiting"), null);
  });

  it("speaks up when a run finishes, not when an idle task stays idle", () => {
    assert.equal(describeChange("running", "idle"), "finished");
    assert.equal(describeChange(undefined, "idle"), null);
  });
});

describe("webhook", () => {
  it("accepts only https", () => {
    assert.equal(isSafeWebhook("https://example.invalid/hook"), true);
    assert.equal(isSafeWebhook("http://example.invalid/hook"), false);
    assert.equal(isSafeWebhook("not a url"), false);
  });

  it("wraps the text in an adaptive card message", () => {
    assert.match(JSON.stringify(teamsPayload("hello")), TEXT_FIELD);
  });
});

describe("startTeamsNotifier", () => {
  it("posts the task title with what happened", async () => {
    const sent: string[] = [];
    const { client, emit } = fakeClient("Fix the nav");
    startTeamsNotifier(client, "https://example.invalid/hook", (_hook, text) => {
      sent.push(text);

      return Promise.resolve();
    });

    emit("running");
    emit("waiting");
    emit("waiting");
    emit("running");
    emit("idle");
    await settle();

    assert.deepEqual(sent, ["Fix the nav needs your input", "Fix the nav finished"]);
  });

  it("survives a failing post", async () => {
    const { client, emit } = fakeClient("x");
    startTeamsNotifier(client, "https://example.invalid/hook", () =>
      Promise.reject(new Error("down")),
    );

    emit("waiting");
    await settle();
  });
});

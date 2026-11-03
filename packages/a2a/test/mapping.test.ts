import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role, type Task, TaskState } from "@a2a-js/sdk";
import { approvalsIn, conversationOf, itemsOf, statusOf, userMessage } from "../src/mapping.ts";

describe("statusOf", () => {
  it("maps every A2A state to a terminal status", () => {
    assert.equal(statusOf(TaskState.TASK_STATE_WORKING), "running");
    assert.equal(statusOf(TaskState.TASK_STATE_INPUT_REQUIRED), "waiting");
    assert.equal(statusOf(TaskState.TASK_STATE_COMPLETED), "idle");
    assert.equal(statusOf(TaskState.TASK_STATE_CANCELED), "idle");
    assert.equal(statusOf(TaskState.TASK_STATE_FAILED), "error");
    assert.equal(statusOf(undefined), "unknown");
  });
});

describe("approvals", () => {
  const ask = {
    id: "a1",
    title: "Run tests?",
    detail: "npm test",
    options: [{ id: "yes", label: "Yes" }],
  };

  it("become approval items when well-formed", () => {
    const message = { ...userMessage("x"), role: Role.ROLE_AGENT, metadata: { approvals: [ask] } };

    assert.deepEqual(approvalsIn(message), [{ kind: "approval", ...ask, answered: null }]);
  });

  it("are ignored when malformed, instead of trusted", () => {
    const message = { ...userMessage("x"), metadata: { approvals: [{ id: 1 }] } };

    assert.deepEqual(approvalsIn(message), []);
    assert.deepEqual(approvalsIn(undefined), []);
  });
});

describe("conversation", () => {
  it("turns messages into user and assistant items, in order, without repeats", () => {
    const user = userMessage("do it");
    const agent = { ...userMessage("done"), role: Role.ROLE_AGENT };
    const task: Task = {
      id: "t",
      contextId: "c",
      status: { state: TaskState.TASK_STATE_COMPLETED, message: agent, timestamp: undefined },
      artifacts: [],
      history: [user, agent],
      metadata: undefined,
    };

    const items = conversationOf(task);

    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant"],
    );
    assert.equal(itemsOf(undefined).length, 0);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { type AgentClient, createAgentClient } from "@dovo-terminal/a2a/client.ts";
import { userMessage } from "@dovo-terminal/a2a/mapping.ts";
import { type RunningAgentServer, startAgentServer } from "@dovo-terminal/a2a/server.ts";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import type { SyncFrame } from "@dovo-terminal/protocol/sync.ts";
import type { Planner } from "../src/planner.ts";
import { singleWorker } from "../src/planner.ts";
import { startOrchestrator } from "../src/server.ts";

const servers: RunningAgentServer[] = [];
const clients: AgentClient[] = [];
after(async () => {
  for (const client of clients) {
    client.close();
  }
  for (const server of servers) {
    await server.close();
  }
});

const UNKNOWN_WORKER = /unknown worker "ghost"/u;
const REFUSED = /already passed through/u;
const ON_ALPHA = /@alpha/u;
const WAITING = /needs-input/u;

async function worker(token: string): Promise<AgentClient> {
  const server = await startAgentServer({ client: createDemoClient(), port: 0, token });
  servers.push(server);
  const client = await createAgentClient({ url: server.url, token });
  clients.push(client);

  return client;
}

async function orchestrator(
  planner: Planner,
  workers: Record<string, AgentClient>,
): Promise<AgentClient> {
  const server = await startOrchestrator({ planner, workers, port: 0, token: "orch-token" });
  servers.push(server);
  const client = await createAgentClient({ url: server.url, token: "orch-token" });
  clients.push(client);

  return client;
}

/** Everything the orchestrator said about a goal, once it reaches a final or waiting status. */
async function outcomeOf(
  client: AgentClient,
  prompt: string,
  metadata = {},
): Promise<{ status: string; said: string }> {
  const frames: SyncFrame[] = [];
  client.subscribe((frame) => frames.push(frame));
  const task = await client.delegate(prompt, metadata);
  const isOver = (value: string) => ["waiting", "idle", "error"].includes(value);
  const deadline = Date.now() + 20_000;
  let status = "";
  while (!isOver(status)) {
    assert.ok(Date.now() < deadline, "timed out waiting for the orchestrator");
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const frame of frames) {
      if (
        frame.type === "event" &&
        frame.event.type === "status" &&
        frame.event.taskId === task.id
      ) {
        status = frame.event.status;
      }
    }
  }
  const said = frames
    .flatMap((frame) =>
      frame.type === "event" &&
      frame.event.type === "item.append" &&
      frame.event.item.kind === "assistant"
        ? [frame.event.item.text]
        : [],
    )
    .join("\n");

  return { status, said };
}

describe("orchestrator over A2A", () => {
  it("plans a goal, runs it on a worker, and reports a step that needs input without answering it", async () => {
    const alpha = await worker("alpha-token");
    const client = await orchestrator(singleWorker("alpha"), { alpha });

    const { status, said } = await outcomeOf(client, "make the nav resilient");

    assert.equal(status, "waiting");
    assert.match(said, ON_ALPHA);
    assert.match(said, WAITING);
  });

  it("fails readably when the planner names a worker that does not exist", async () => {
    const alpha = await worker("alpha-token-2");
    const planner: Planner = () =>
      Promise.resolve({ steps: [{ id: "one", worker: "ghost", goal: "do it" }] });
    const client = await orchestrator(planner, { alpha });

    const { status, said } = await outcomeOf(client, "anything");

    assert.equal(status, "error");
    assert.match(said, UNKNOWN_WORKER);
  });

  it("refuses a goal that has passed through too many orchestrators", async () => {
    const alpha = await worker("alpha-token-3");
    const client = await orchestrator(singleWorker("alpha"), { alpha });

    const { status, said } = await outcomeOf(client, "go", { hops: 3 });

    assert.equal(status, "error");
    assert.match(said, REFUSED);
  });

  it("carries on after a restart without starting the worker's task a second time", async () => {
    const backend = createDemoClient();
    const alphaServer = await startAgentServer({
      client: backend,
      port: 0,
      token: "alpha-restart",
    });
    servers.push(alphaServer);
    const dbPath = join(mkdtempSync(join(tmpdir(), "dovo-orch-")), "orchestrator.db");
    const goal = userMessage("make the nav resilient");

    async function askOrchestrator(): Promise<Task> {
      const alpha = await createAgentClient({ url: alphaServer.url, token: "alpha-restart" });
      const orch = await startOrchestrator({
        planner: singleWorker("alpha"),
        workers: { alpha },
        port: 0,
        token: "orch-restart",
        dbPath,
      });
      const client = await new ClientFactory().createFromUrl(orch.url);
      const result = await client.sendMessage(
        { tenant: "", message: goal, configuration: undefined, metadata: undefined },
        { serviceParameters: { authorization: "Bearer orch-restart" } },
      );
      await orch.close();
      alpha.close();
      assert.ok("status" in result, "a task comes back");

      return result;
    }

    const first = await askOrchestrator();
    const tasksAfterFirst = (await backend.listTasks()).length;
    const second = await askOrchestrator();

    assert.equal(first.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal(second.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal(
      (await backend.listTasks()).length,
      tasksAfterFirst,
      "the worker's task was not created again",
    );
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type Message, Role, type Task, TaskState } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import {
  type AgentServerOptions,
  type RunningAgentServer,
  startAgentServer,
} from "../src/server.ts";

const opened: RunningAgentServer[] = [];
after(async () => {
  for (const server of opened) {
    await server.close();
  }
});

const NOT_ALLOWED = /not allowed on this worker/u;
const BUSY = /worker busy/u;

function message(text: string, extra: Partial<Message> = {}): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
    ...extra,
  };
}

async function start(
  options: Partial<AgentServerOptions>,
  token = "test-token",
): Promise<RunningAgentServer> {
  const server = await startAgentServer({ client: createDemoClient(), port: 0, token, ...options });
  opened.push(server);

  return server;
}

async function send(server: RunningAgentServer, outgoing: Message): Promise<Task> {
  const client = await new ClientFactory().createFromUrl(server.url);
  const result = await client.sendMessage(
    { tenant: "", message: outgoing, configuration: undefined, metadata: undefined },
    { serviceParameters: { authorization: `Bearer ${server.token}` } },
  );
  assert.ok("status" in result, "a task comes back");

  return result;
}

function replyText(task: Task): string {
  const content = task.status?.message?.parts[0]?.content;

  return content?.$case === "text" ? content.value : "";
}

const dbIn = () => join(mkdtempSync(join(tmpdir(), "dovo-a2a-test-")), "a2a.db");

describe("worker hardening", () => {
  it("declares its bearer scheme in the agent card", async () => {
    const server = await start({});
    const card: { securitySchemes: Record<string, unknown> } = JSON.parse(
      await (await fetch(`${server.url}/.well-known/agent-card.json`)).text(),
    );

    assert.ok(Object.keys(card.securitySchemes).includes("bearer"));
  });

  it("advertises the configured public address, not the listen address", async () => {
    const server = await start({ publicUrl: "https://worker.example.invalid" });
    const card = await (await fetch(`${server.url}/.well-known/agent-card.json`)).text();

    assert.ok(card.includes("https://worker.example.invalid/a2a/jsonrpc"));
  });

  it("does not create a second Dovo task when the same message is delivered again", async () => {
    const backend = createDemoClient();
    const server = await start({ client: backend });
    const once = message("make it resilient");

    await send(server, once);
    await send(server, once);

    assert.equal((await backend.listTasks()).length, 2, "the seed task plus exactly one new one");
  });

  it("keeps working on the same Dovo task after the worker restarts", async () => {
    const backend = createDemoClient();
    const dbPath = dbIn();
    const first = await start({ client: backend, dbPath, token: "t1" });
    const task = await send(first, message("start the work"));
    await first.close();

    const second = await start({ client: backend, dbPath, token: "t2" });
    const followed = await send(
      second,
      message("keep going", { taskId: task.id, contextId: task.contextId }),
    );

    assert.equal(followed.id, task.id);
    assert.equal((await backend.listTasks()).length, 2, "no extra Dovo task after the restart");
  });

  it("refuses a project that is not on the allowlist, and creates nothing", async () => {
    const backend = createDemoClient();
    const server = await start({ client: backend, allow: { projects: ["p-alpha"] } });

    const refused = await send(server, message("go", { metadata: { projectId: "p-beta" } }));

    assert.equal(refused.status?.state, TaskState.TASK_STATE_FAILED);
    assert.match(replyText(refused), NOT_ALLOWED);
    assert.equal((await backend.listTasks()).length, 1);
  });

  it("refuses an agent that is not on the allowlist", async () => {
    const server = await start({ allow: { providers: ["claude"] } });

    const refused = await send(server, message("go", { metadata: { providerId: "codex" } }));

    assert.match(replyText(refused), NOT_ALLOWED);
  });

  it("refuses a request body far larger than any message", async () => {
    const server = await start({});

    const response = await fetch(`${server.url}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { pad: "x".repeat(2_000_000) },
      }),
    });

    assert.equal(response.status, 413);
  });

  it("refuses work when too many turns are already running", async () => {
    const server = await start({ maxActive: 0 });

    const refused = await send(server, message("go"));

    assert.equal(refused.status?.state, TaskState.TASK_STATE_FAILED);
    assert.match(replyText(refused), BUSY);
  });
});

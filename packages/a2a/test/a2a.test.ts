import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { type Message, Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import { type RunningAgentServer, startAgentServer } from "../src/server.ts";

const opened: RunningAgentServer[] = [];
after(async () => {
  for (const server of opened) {
    await server.close();
  }
});

async function start(): Promise<RunningAgentServer> {
  const server = await startAgentServer({ client: createDemoClient(), port: 0 });
  opened.push(server);

  return server;
}

function userMessage(text: string): Message {
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
  };
}

describe("A2A server", () => {
  it("publishes a public agent card that points at its own endpoint", async () => {
    const server = await start();
    const response = await fetch(`${server.url}/.well-known/agent-card.json`);
    const card: { name: string } = JSON.parse(await response.text());

    assert.equal(response.status, 200);
    assert.equal(card.name, "Dovo");
    assert.ok(JSON.stringify(card).includes(server.url));
  });

  it("refuses to run work without the token", async () => {
    const server = await start();
    const response = await fetch(`${server.url}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} }),
    });

    assert.equal(response.status, 401);
  });

  it("runs a task for a client with the token and reports it needs input", async () => {
    const server = await start();
    const client = await new ClientFactory().createFromUrl(server.url);
    const outcome = await client.sendMessage(
      {
        tenant: "",
        message: userMessage("make the nav resilient"),
        configuration: undefined,
        metadata: undefined,
      },
      { serviceParameters: { authorization: `Bearer ${server.token}` } },
    );

    assert.ok("status" in outcome, "a task comes back");
    assert.equal(outcome.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    const first = outcome.status?.message?.parts[0]?.content;
    assert.ok(first?.$case === "text" && first.value.includes("make the nav resilient"));
  });
});

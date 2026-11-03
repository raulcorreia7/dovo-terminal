import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import type { SyncFrame } from "@dovo-terminal/protocol/sync.ts";
import { AGENT_ID, createAgentClient, pinnedFetch } from "../src/client.ts";
import { type RunningAgentServer, startAgentServer } from "../src/server.ts";

const opened: RunningAgentServer[] = [];
after(async () => {
  for (const server of opened) {
    await server.close();
  }
});

async function worker(publicUrl?: string): Promise<RunningAgentServer> {
  const server = await startAgentServer({
    client: createDemoClient(),
    port: 0,
    token: "worker-token",
    ...(publicUrl && { publicUrl }),
  });
  opened.push(server);

  return server;
}

async function waitFor(frames: SyncFrame[], match: (frame: SyncFrame) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!frames.some(match)) {
    assert.ok(Date.now() < deadline, "timed out waiting for the worker");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const isStatus = (status: string) => (frame: SyncFrame) =>
  frame.type === "event" && frame.event.type === "status" && frame.event.status === status;
const isApproval = (frame: SyncFrame) =>
  frame.type === "event" &&
  frame.event.type === "item.append" &&
  frame.event.item.kind === "approval";

describe("pinnedFetch", () => {
  it("keeps the path but never the host, and always sends the token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const recording: typeof fetch = (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });

      return Promise.resolve(new Response("ok"));
    };
    const pinned = pinnedFetch("http://10.0.0.5:8791", "secret", recording);

    await pinned("http://evil.invalid:9/a2a/jsonrpc?x=1");
    await pinned(new URL("https://evil.invalid/.well-known/agent-card.json"));

    assert.deepEqual(seen, [
      { url: "http://10.0.0.5:8791/a2a/jsonrpc?x=1", auth: "Bearer secret" },
      { url: "http://10.0.0.5:8791/.well-known/agent-card.json", auth: "Bearer secret" },
    ]);
  });
});

describe("createAgentClient", () => {
  it("offers the core and one stand-in project, and none of the optional abilities", async () => {
    const server = await worker();
    const client = await createAgentClient({ url: server.url, token: server.token });

    const projects = await client.listProjects();

    assert.equal(projects[0]?.id, AGENT_ID);
    assert.equal(client.archive, undefined);
    assert.equal(client.devices, undefined);
    assert.equal(client.ports, undefined);
    client.close();
  });

  it("starts a task, shows the approval it asks for, and carries on when answered", async () => {
    const server = await worker();
    const client = await createAgentClient({ url: server.url, token: server.token });
    const frames: SyncFrame[] = [];
    client.subscribe((frame) => frames.push(frame));

    const task = await client.createTask({
      projectId: AGENT_ID,
      providerId: AGENT_ID,
      prompt: "make it resilient",
    });
    assert.equal(task.title, "make it resilient");
    await waitFor(frames, isStatus("waiting"));
    await waitFor(frames, isApproval);

    const approval = frames.flatMap((frame) =>
      frame.type === "event" &&
      frame.event.type === "item.append" &&
      frame.event.item.kind === "approval"
        ? [frame.event.item]
        : [],
    )[0];
    assert.ok(approval);
    frames.length = 0;
    await client.answerItem(task.id, approval.id, approval.options[0]?.id ?? "yes");
    await waitFor(frames, (frame) => frame.type === "event");

    const history = await client.getTaskHistory(task.id);
    assert.ok(history.items.some((item) => item.kind === "user"));
    client.close();
  });

  it("is not redirected by a card that advertises another address", async () => {
    const server = await worker("http://evil.invalid:9");
    const client = await createAgentClient({ url: server.url, token: server.token });

    const task = await client.createTask({
      projectId: AGENT_ID,
      providerId: AGENT_ID,
      prompt: "go",
    });

    assert.ok(task.id);
    client.close();
  });

  it("fails clearly when the worker is gone", async () => {
    const server = await worker();
    const client = await createAgentClient({ url: server.url, token: server.token });
    await server.close();

    await assert.rejects(
      client.createTask({ projectId: AGENT_ID, providerId: AGENT_ID, prompt: "go" }),
    );
    client.close();
  });
});

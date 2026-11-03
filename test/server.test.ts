// The local runtime server over raw HTTP + /ws/sync, backed by DemoClient.
// Proves the client needs nothing but a loopback server: no Dovo anywhere.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createDemoClient } from "../src/client/demo.ts";
import { ENDPOINTS, syncUrl } from "../src/protocol/http.ts";
import { startRuntimeServer, type RunningRuntimeServer } from "../src/server/index.ts";
import { SyncFrameSchema } from "../src/protocol/sync.ts";
import { ProjectSchema, TaskHistorySchema, TaskSummarySchema } from "../src/protocol/workspace.ts";

const opened: RunningRuntimeServer[] = [];
function track(server: RunningRuntimeServer): RunningRuntimeServer {
  opened.push(server);
  return server;
}
test.after(async () => {
  for (const server of opened.splice(0)) await server.close();
});

async function start(): Promise<RunningRuntimeServer> {
  return track(await startRuntimeServer({ client: createDemoClient(), port: 0 }));
}

test("health answers without auth or backend calls", async () => {
  const server = await start();
  const response = await fetch(server.url + ENDPOINTS.health);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("reads map onto the RuntimeClient interface", async () => {
  const server = await start();
  const projects = ProjectSchema.array().parse(
    await fetch(server.url + ENDPOINTS.projects).then((r) => r.json()),
  );
  assert.ok(projects.length > 0 && typeof projects[0]?.id === "string");
  const tasks = TaskSummarySchema.array().parse(
    await fetch(server.url + ENDPOINTS.tasks).then((r) => r.json()),
  );
  const first = tasks[0];
  assert.ok(first);
  const history = TaskHistorySchema.parse(
    await fetch(`${server.url}${ENDPOINTS.taskHistory}?taskId=${first.id}`).then((r) => r.json()),
  );
  assert.ok(history.items.some((item) => item.kind === "user"));
});

test("create -> message -> history works end to end over the wire", async () => {
  const server = await start();
  const created = await fetch(server.url + ENDPOINTS.createTask, {
    method: "POST",
    body: JSON.stringify({ projectId: "p-alpha", providerId: "codex", prompt: "hello wire" }),
  });
  assert.equal(created.status, 200);
  const task = TaskSummarySchema.parse(await created.json());
  await fetch(server.url + ENDPOINTS.sendMessage, {
    method: "POST",
    body: JSON.stringify({ taskId: task.id, text: "and a follow-up" }),
  });
  const history = TaskHistorySchema.parse(
    await fetch(`${server.url}${ENDPOINTS.taskHistory}?taskId=${task.id}`).then((r) => r.json()),
  );
  const texts = history.items.map((item) => ("text" in item ? item.text : ""));
  assert.ok(texts.some((text) => text.includes("hello wire")));
});

test("unknown task ids surface as 400, not 500", async () => {
  const server = await start();
  const response = await fetch(`${server.url}${ENDPOINTS.taskHistory}?taskId=bogus`);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /unknown task/);
});

test("invalid bodies are rejected with 400 before reaching the runtime", async () => {
  const server = await start();
  const response = await fetch(server.url + ENDPOINTS.sendMessage, {
    method: "POST",
    body: JSON.stringify({ taskId: "", text: "" }),
  });
  assert.equal(response.status, 400);
});

test("unknown paths and methods never reach the runtime", async () => {
  const server = await start();
  assert.equal((await fetch(server.url + "/api/nope")).status, 404);
  assert.equal((await fetch(server.url + ENDPOINTS.tasks, { method: "DELETE" })).status, 404);
});

test("lifecycle: archive hides, restore returns, delete removes", async () => {
  const server = await start();
  const list = async () => {
    const tasks = TaskSummarySchema.array().parse(
      await fetch(server.url + ENDPOINTS.tasks).then((r) => r.json()),
    );
    return tasks.map((x) => x.id);
  };
  const response = await fetch(server.url + ENDPOINTS.createTask, {
    method: "POST",
    body: JSON.stringify({ projectId: "p-alpha", providerId: "codex", prompt: "lifecycle" }),
  });
  const id = TaskSummarySchema.parse(await response.json()).id;
  const lifecycle = (action: string) =>
    fetch(server.url + ENDPOINTS.lifecycle, { method: "POST", body: JSON.stringify({ taskId: id, action }) });

  assert.equal((await lifecycle("archive")).status, 204);
  assert.ok(!(await list()).includes(id));
  await lifecycle("restore");
  assert.ok((await list()).includes(id));
  assert.equal((await lifecycle("delete")).status, 204);
  assert.ok(!(await list()).includes(id));
});

test("/ws/sync streams validated frames to every connected client", async () => {
  const server = await start();
  const frames1: unknown[] = [];
  const frames2: unknown[] = [];
  const collect = (target: unknown[]) =>
    new Promise<WebSocket>((resolveSocket, rejectSocket) => {
      const socket = new WebSocket(syncUrl(server.url));
      socket.on("message", (raw: Buffer) => {
        const frame = SyncFrameSchema.parse(JSON.parse(String(raw))); // a bad frame fails the test
        target.push(frame);
      });
      socket.on("error", rejectSocket);
      socket.on("open", () => resolveSocket(socket));
    });
  const sockets = await Promise.all([collect(frames1), collect(frames2)]);

  await fetch(server.url + ENDPOINTS.createTask, {
    method: "POST",
    body: JSON.stringify({ projectId: "p-alpha", providerId: "codex", prompt: "sync please" }),
  });
  await delay(1500); // demo runtime streams tool + assistant items over ~2 s

  const eventFrames = frames1.filter(
    (frame) => (frame as { type: string }).type === "event",
  ) as { event: { type: string; item?: { kind?: string } } }[];
  assert.ok(eventFrames.some((f) => f.event.type === "item.append"), "got item.append");
  assert.ok(
    eventFrames.some((f) => f.event.item?.kind === "tool"),
    "got tool activity",
  );
  assert.ok(frames2.length > 0, "second client received frames too");
  for (const socket of sockets) socket.close();
  await delay(50);
});

test("close() finalizes server, sockets, and the wrapped runtime", async () => {
  const client = createDemoClient();
  let connectionState: boolean | null = null;
  let disconnects = 0;
  client.subscribe((frame) => {
    if (frame.type === "connection") {
      connectionState = frame.connected;
      if (!frame.connected) disconnects += 1;
    }
  });
  const server = await startRuntimeServer({ client, port: 0 });
  assert.equal(connectionState, true, "connect frame arrives at startup");
  await server.close(); // must resolve: no keep-alive or ws handle left open
  assert.equal(disconnects, 1, "client saw exactly one disconnect");
});

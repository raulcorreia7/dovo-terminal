// One behavioral suite, two routes: { via: "direct" } and { via: "loopback" }.
// Same assertions, same backend - proof that nothing in the RuntimeClient
// contract leaks the presence or absence of the local server. Closing the
// session must leave nothing running: each test asserts it resolves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openRuntime, type RuntimeRoute } from "../src/client/connect.ts";
import { type RuntimeClient } from "../src/client/runtime-client.ts";
import { createDemoClient } from "../src/demo/runtime.ts";
import { startRuntimeServer, type RunningRuntimeServer } from "../src/server/index.ts";
import type { SyncFrame } from "../src/protocol/sync.ts";
import { TaskStatusSchema } from "../src/protocol/workspace.ts";

const ROUTES: Record<string, RuntimeRoute> = {
  direct: { via: "direct" },
  loopback: { via: "loopback" },
};

/** What `dovo serve` runs: a server alone, no TUI on this side. */
function hostedServer(): Promise<RunningRuntimeServer> {
  return startRuntimeServer({ client: createDemoClient(), port: 0 });
}

/** The shared contract exercise; receives only a RuntimeClient. */
async function exerciseRuntimeClient(client: RuntimeClient): Promise<void> {
  const frames: SyncFrame[] = [];
  const unsubscribe = client.subscribe((frame) => frames.push(frame));
  client.connect();

  // reads
  const projects = await client.listProjects();
  assert.ok(projects.length > 0);
  const providers = await client.listProviders();
  assert.ok(providers.some((p) => p.id === "codex"));

  // create + realtime delivery
  const task = await client.createTask({
    projectId: projects[0]!.id,
    providerId: "codex",
    prompt: "integration check\nsecond line ignored",
  });
  assert.equal(task.status, "running");
  client.focusTask(task.id);

  const sawTool = await waitFor(() =>
    frames.some(
      (f) => f.type === "event" && f.event.type === "item.append" && f.event.item.kind === "tool",
    ),
  );
  assert.ok(sawTool, "tool activity streamed via subscribe");
  const sawSync = frames.some((f) => f.type === "sync");
  assert.ok(sawSync, "sync hint arrives");

  // history reflects the conversation
  const history = await client.getTaskHistory(task.id);
  assert.ok(history.items.some((i) => i.kind === "user" && i.text.startsWith("integration check")));
  TaskStatusSchema.parse(history.status);

  // stop, then lifecycle, all through the same interface
  await client.stopTask(task.id);
  await client.setTaskArchived(task.id, true);
  const afterArchive = await client.listTasks();
  assert.ok(!afterArchive.some((t) => t.id === task.id), "archive hides the task");
  await client.setTaskArchived(task.id, false);
  assert.ok((await client.listTasks()).some((t) => t.id === task.id), "restore brings it back");
  await client.deleteTask(task.id);
  assert.ok(!(await client.listTasks()).some((t) => t.id === task.id), "delete removes it");

  // unsubscribe is final
  unsubscribe();
  const countAfter = frames.length;
  await client.createTask({ projectId: projects[0]!.id, providerId: "codex", prompt: "quiet" });
  await delay(400);
  assert.equal(frames.length, countAfter, "unsubscribed listener stays quiet");
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

for (const [name, route] of Object.entries(ROUTES)) {
  test(`RuntimeClient behaves identically via ${name}`, async () => {
    const backend = createDemoClient();
    const session = await openRuntime(backend, route);
    try {
      await exerciseRuntimeClient(session.client);
    } finally {
      await session.close(); // must resolve: every resource finalized
    }
    // a second close is harmless
    await session.close();
  });
}

test("openRuntime with via:server reaches a standalone dovo serve", async () => {
  const hosted = await hostedServer();
  try {
    const session = await openRuntime(null, { via: "server", url: hosted.url });
    try {
      assert.ok((await session.client.listProjects()).length > 0);
      await session.client.createTask({
        projectId: "p-alpha",
        providerId: "claude",
        prompt: "through a standalone server",
      });
    } finally {
      await session.close(); // closes only its own client, not the host
    }
    const again = await openRuntime(null, { via: "server", url: hosted.url });
    try {
      assert.ok((await again.client.listTasks()).length > 0, "host still serving");
    } finally {
      await again.close();
    }
  } finally {
    await hosted.close();
  }
});

test("connection state flows to subscribers, loopback included", async () => {
  const hosted = await hostedServer();
  const session = await openRuntime(null, { via: "server", url: hosted.url });
  const states: boolean[] = [];
  session.client.subscribe((frame) => {
    if (frame.type === "connection") states.push(frame.connected);
  });
  session.client.connect();
  assert.ok(await waitFor(() => states.includes(true)), "connected frame arrives");
  await hosted.close(); // the server going down must be observable downward
  assert.ok(await waitFor(() => states.includes(false)), "disconnect frame arrives");
  await session.close();
});

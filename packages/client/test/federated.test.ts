import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SyncFrame } from "@dovo-terminal/protocol/sync.ts";
import { createDemoClient } from "../src/demo.ts";
import { createFederatedClient } from "../src/federated.ts";

const WRONG_MACHINE = /cannot run an agent from server/u;
const UNKNOWN_MACHINE = /unknown machine/u;

function twoMachines() {
  const laptop = createDemoClient();
  const server = createDemoClient();
  const federation = createFederatedClient([
    { name: "laptop", client: laptop },
    { name: "server", client: server },
  ]);

  return { laptop, server, federation };
}

describe("createFederatedClient", () => {
  it("needs machines with distinct names that avoid the separator", () => {
    assert.throws(() => createFederatedClient([]));
    const demo = createDemoClient();
    assert.throws(() =>
      createFederatedClient([
        { name: "a", client: demo },
        { name: "a", client: demo },
      ]),
    );
    assert.throws(() => createFederatedClient([{ name: "a@b", client: demo }]));
  });

  it("merges projects and tasks, keeping same-named ids apart", async () => {
    const { federation } = twoMachines();
    const projects = await federation.listProjects();
    const ids = projects.map((project) => project.id);

    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes("p-alpha@laptop") && ids.includes("p-alpha@server"));
    assert.ok(projects.some((project) => project.name === "website (laptop)"));

    const tasks = await federation.listTasks();
    assert.equal(tasks.length, 2);
    assert.ok(
      tasks.every(
        (task) => task.projectId.endsWith("@laptop") || task.projectId.endsWith("@server"),
      ),
    );
  });

  it("creates a task on the machine its project lives on", async () => {
    const { laptop, server, federation } = twoMachines();
    const created = await federation.createTask({
      projectId: "p-beta@server",
      providerId: "codex@server",
      prompt: "build it on the server",
    });

    assert.ok(created.id.endsWith("@server"));
    assert.equal((await server.listTasks()).length, 2);
    assert.equal((await laptop.listTasks()).length, 1);
  });

  it("refuses an agent from a different machine than the project", async () => {
    const { federation } = twoMachines();

    await assert.rejects(
      federation.createTask({
        projectId: "p-alpha@laptop",
        providerId: "codex@server",
        prompt: "x",
      }),
      WRONG_MACHINE,
    );
  });

  it("routes history and lifecycle calls by the machine in the id", async () => {
    const { laptop, federation } = twoMachines();
    const [first] = await federation.listTasks();
    assert.ok(first);

    const history = await federation.getTaskHistory(first.id);
    assert.ok(history.items.length > 0);

    await federation.deleteTask("t-old@laptop");
    assert.equal((await laptop.listTasks()).length, 0);
    assert.equal((await federation.listTasks()).length, 1);
  });

  it("offers an ability only when some machine has it", () => {
    const bare = Object.create(createDemoClient(), {
      archive: { value: undefined },
      devices: { value: undefined },
      ports: { value: undefined },
    });
    const none = createFederatedClient([{ name: "a", client: bare }]);
    const some = createFederatedClient([
      { name: "a", client: bare },
      { name: "b", client: createDemoClient() },
    ]);

    assert.equal(none.archive, undefined);
    assert.equal(none.devices, undefined);
    assert.equal(none.ports, undefined);
    assert.ok(some.archive && some.devices && some.ports);
  });

  it("merges abilities across machines, skipping those that lack them", async () => {
    const bare = Object.create(createDemoClient(), { ports: { value: undefined } });
    const federation = createFederatedClient([
      { name: "a", client: bare },
      { name: "b", client: createDemoClient() },
    ]);

    const ports = (await federation.ports?.list()) ?? [];

    assert.equal(ports.length, 1);
    assert.equal(ports[0]?.projectId, "p-alpha@b");
  });

  it("rejects, never throws, for an id that names no machine", async () => {
    const { federation } = twoMachines();

    await assert.rejects(federation.deleteTask("t-old@nowhere"), UNKNOWN_MACHINE);
    await assert.rejects(federation.getTaskHistory("no-separator"), UNKNOWN_MACHINE);
  });

  it("tags events with the machine so the UI can route them", async () => {
    const { federation } = twoMachines();
    const seen: SyncFrame[] = [];
    federation.subscribe((frame) => seen.push(frame));
    federation.connect();
    const created = await federation.createTask({
      projectId: "p-alpha@laptop",
      providerId: "codex@laptop",
      prompt: "stream something",
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    federation.close();

    const events = seen.filter((frame) => frame.type === "event");
    assert.ok(events.length > 0);
    assert.ok(events.every((frame) => frame.event.taskId.endsWith("@laptop")));
    assert.ok(events.some((frame) => frame.event.taskId === created.id));
  });
});

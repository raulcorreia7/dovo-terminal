import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import { parseAge, prune, selectOld } from "../src/prune.ts";

const HOUR = 3_600_000;
const BAD_AGE = /age must look like/u;

describe("parseAge", () => {
  it("reads days and hours", () => {
    assert.equal(parseAge("30d"), 30 * 24 * HOUR);
    assert.equal(parseAge("12h"), 12 * HOUR);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "30", "d", "0d", "-1d", "1w", "1.5d"]) {
      assert.throws(() => parseAge(bad), BAD_AGE, bad);
    }
  });
});

describe("selectOld", () => {
  it("keeps only tasks older than the age", () => {
    const now = 100 * HOUR;
    const tasks = [
      { id: "old", updatedAt: now - 50 * HOUR },
      { id: "new", updatedAt: now - HOUR },
    ] as never[];

    assert.deepEqual(
      selectOld(tasks, 10 * HOUR, now).map((task) => task.id),
      ["old"],
    );
  });
});

describe("prune", () => {
  async function archivedDemo() {
    const client = createDemoClient();
    await client.setTaskArchived("t-old", true);

    return client;
  }

  it("a dry run lists but never deletes", async () => {
    const client = await archivedDemo();
    const report = await prune(client, HOUR / 2, { apply: false });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.deleted, 0);
    assert.equal(((await client.archive?.list()) ?? []).length, 1);
  });

  it("deletes only archived tasks that are old enough", async () => {
    const client = await archivedDemo();
    const tooRecent = await prune(client, 24 * HOUR, { apply: true });
    assert.equal(tooRecent.deleted, 0);

    const old = await prune(client, HOUR / 2, { apply: true });
    assert.equal(old.deleted, 1);
    assert.equal(((await client.archive?.list()) ?? []).length, 0);
  });

  it("never touches a task that is not archived", async () => {
    const client = createDemoClient();
    const report = await prune(client, 1, { apply: true });

    assert.equal(report.candidates.length, 0);
    assert.equal((await client.listTasks()).length, 1);
  });
});

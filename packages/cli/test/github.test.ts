import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createGithubNotes, summarizePullRequest } from "../src/github.ts";

const pr = (state: string, checks: Record<string, unknown>[] | null) => ({
  number: 7,
  state,
  statusCheckRollup: checks,
});

describe("summarizePullRequest", () => {
  it("passes when every check succeeded", () => {
    assert.equal(summarizePullRequest(pr("OPEN", [{ conclusion: "SUCCESS" }])), "PR #7 ✓");
  });

  it("fails when any check failed, even if others are pending", () => {
    const checks = [{ conclusion: "FAILURE" }, { status: "IN_PROGRESS" }];

    assert.equal(summarizePullRequest(pr("OPEN", checks)), "PR #7 ✗");
  });

  it("shows pending while checks run", () => {
    assert.equal(summarizePullRequest(pr("OPEN", [{ status: "QUEUED" }])), "PR #7 …");
  });

  it("names a closed or merged PR instead of its checks", () => {
    assert.equal(summarizePullRequest(pr("MERGED", [{ conclusion: "FAILURE" }])), "PR #7 merged");
  });

  it("has no verdict without checks", () => {
    assert.equal(summarizePullRequest(pr("OPEN", null)), "PR #7");
  });
});

describe("createGithubNotes", () => {
  const folder = mkdtempSync(join(tmpdir(), "dovo-gh-"));
  const project = { id: "p", name: "p", path: folder };

  it("asks gh in the project folder and caches the answer", async () => {
    let calls = 0;
    const notes = createGithubNotes((cwd) => {
      calls += 1;
      assert.equal(cwd, folder);

      return Promise.resolve(JSON.stringify(pr("OPEN", [{ conclusion: "SUCCESS" }])));
    });

    assert.equal(await notes(project), "PR #7 ✓");
    assert.equal(await notes(project), "PR #7 ✓");
    assert.equal(calls, 1);
  });

  it("has no note when gh fails (no PR, signed out, not installed)", async () => {
    const notes = createGithubNotes(() => Promise.reject(new Error("no pull requests found")));

    assert.equal(await notes(project), undefined);
  });

  it("never runs gh for a path that is not a local folder", async () => {
    const notes = createGithubNotes(() => Promise.reject(new Error("must not run")));

    assert.equal(await notes({ id: "r", name: "r", path: "/no/such/folder" }), undefined);
  });
});

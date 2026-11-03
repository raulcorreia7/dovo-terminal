import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Config } from "../src/config.ts";
import { shellForProject, shellPlan, shellQuote } from "../src/shell.ts";

const NOT_USABLE = /not a usable ssh host/u;
const NUL = /NUL/u;

describe("shellQuote", () => {
  const nasty = [
    "plain",
    "with space",
    "it's",
    'a"b',
    "$(touch /tmp/x)",
    "`id`",
    "a;b|c&d",
    "line\nbreak",
    "-rf",
    "",
  ];

  it("round-trips every awkward path through a real shell unchanged", () => {
    for (const text of nasty) {
      const echoed = execFileSync("sh", ["-c", `printf %s ${shellQuote(text)}`]).toString();

      assert.equal(echoed, text, JSON.stringify(text));
    }
  });

  it("refuses a NUL byte", () => {
    assert.throws(() => shellQuote("a\0b"), NUL);
  });
});

describe("shellPlan", () => {
  it("runs the user's own shell in the folder when the machine is this one", () => {
    const folder = mkdtempSync(join(tmpdir(), "dovo-shell-"));
    const plan = shellPlan({ path: folder }, "/bin/zsh");

    assert.equal(plan.command, "/bin/zsh");
    assert.equal(plan.cwd, folder);
  });

  it("falls back to sh, and to the home folder when the path is not here", () => {
    const plan = shellPlan({ path: "/no/such/place" }, undefined);

    assert.equal(plan.command, "/bin/sh");
    assert.notEqual(plan.cwd, "/no/such/place");
  });

  it("uses ssh -t with the host after -- and the path quoted", () => {
    const plan = shellPlan({ path: "/srv/my app/it's", ssh: "me@box" }, undefined);

    assert.equal(plan.command, "ssh");
    assert.equal(plan.args[0], "-t");
    const dashes = plan.args.indexOf("--");
    assert.equal(plan.args[dashes + 1], "me@box");
    assert.ok(plan.args[dashes + 2]?.startsWith("cd -- '/srv/my app/it'\\''s' && exec"));
  });

  it("never lets a host become an option", () => {
    assert.throws(
      () => shellPlan({ path: "/x", ssh: "-oProxyCommand=evil" }, undefined),
      NOT_USABLE,
    );
  });
});

describe("shellForProject", () => {
  const project = { id: "p1", name: "p1", path: "/srv/app" };
  const config = (url: string, ssh?: string): Config => ({
    current: "box",
    runtimes: { box: { url, ...(ssh && { ssh }) } },
  });

  it("opens a local shell for a runtime on this machine", () => {
    assert.equal(
      shellForProject(project, {}, config("http://127.0.0.1:8787"))?.command !== "ssh",
      true,
    );
  });

  it("goes through ssh when the profile names a host", () => {
    assert.equal(
      shellForProject(project, {}, config("http://127.0.0.1:8787", "me@box"))?.command,
      "ssh",
    );
  });

  it("has no shell for a remote runtime that has no ssh host", () => {
    assert.equal(shellForProject(project, {}, config("http://10.0.0.5:8787")), undefined);
  });

  it("reads the machine from a federated project id", () => {
    const federated = { ...project, id: "p1@box" };

    assert.equal(
      shellForProject(federated, { all: true }, config("http://127.0.0.1:8787", "me@box"))?.command,
      "ssh",
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServicePort } from "@dovo-terminal/protocol/workspace.ts";
import {
  canOpenBrowser,
  forwardArgs,
  openerFor,
  openService,
  sameService,
  sessionOf,
} from "../src/services.ts";

const SERVICE: ServicePort = {
  port: 3000,
  command: "vite",
  folder: "/srv/web",
  projectId: "web",
  pid: 10,
  started: "t0",
};
const NOT_USABLE = /not a usable ssh host/u;
const CHANGED = /no longer the same service/u;
const CLASH = /already in use on this machine/u;

const clientWith = (ports: ServicePort[]) => ({ ports: { list: () => Promise.resolve(ports) } });

describe("platform helpers", () => {
  it("picks the opener for macOS and Linux", () => {
    assert.equal(openerFor("darwin"), "open");
    assert.equal(openerFor("linux"), "xdg-open");
    assert.equal(openerFor("win32"), undefined);
  });

  it("does not open a browser from an ssh session or without a display", () => {
    assert.equal(canOpenBrowser({ remote: true, display: true }), false);
    assert.equal(canOpenBrowser({ remote: false, display: false }), false);
    assert.equal(canOpenBrowser({ remote: false, display: true }), true);
  });

  it("reads the session from the environment, per platform", () => {
    const ssh = Object.fromEntries([["SSH_CONNECTION", "a b c d"]]);

    assert.deepEqual(sessionOf(ssh, "darwin"), { remote: true, display: true });
    assert.deepEqual(sessionOf({}, "linux"), { remote: false, display: false });
    assert.deepEqual(sessionOf({}, "darwin"), { remote: false, display: true });
  });
});

describe("sameService / forwardArgs", () => {
  it("is the same service only for the same port, process and start time", () => {
    assert.equal(sameService(SERVICE, { ...SERVICE }), true);
    assert.equal(sameService(SERVICE, { ...SERVICE, pid: 11 }), false);
    assert.equal(sameService(SERVICE, { ...SERVICE, started: "t1" }), false);
  });

  it("forwards exactly one port, loopback to loopback, after --", () => {
    const args = forwardArgs("me@box", 3000);

    assert.ok(args.includes("127.0.0.1:3000:127.0.0.1:3000"));
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "me@box");
    assert.throws(() => forwardArgs("-oProxyCommand=x", 3000), NOT_USABLE);
  });
});

describe("openService", () => {
  const launches: string[] = [];
  const base = {
    env: Object.fromEntries([["DISPLAY", ":0"]]),
    platform: "linux" as const,
    launch: (_command: string, url: string) => launches.push(url),
    listening: () => Promise.resolve(false),
  };

  it("on this machine, opens a plain loopback URL without any forward", async () => {
    const forwards: string[][] = [];
    const message = await openService(SERVICE, {
      ...base,
      client: clientWith([SERVICE]),
      forward: (args) => {
        forwards.push(args);

        return Promise.resolve();
      },
    });

    assert.equal(message, "opened http://127.0.0.1:3000");
    assert.equal(forwards.length, 0);
  });

  it("refuses a port that now belongs to a different process, and forwards nothing", async () => {
    const forwards: string[][] = [];
    const message = await openService(SERVICE, {
      ...base,
      ssh: "me@box",
      client: clientWith([{ ...SERVICE, pid: 99 }]),
      forward: (args) => {
        forwards.push(args);

        return Promise.resolve();
      },
    });

    assert.match(message, CHANGED);
    assert.equal(forwards.length, 0);
  });

  it("over ssh, forwards the one port first, and only once", async () => {
    const forwards: string[][] = [];
    const context = {
      ...base,
      ssh: "me@forwarded-once",
      client: clientWith([SERVICE]),
      forward: (args: string[]) => {
        forwards.push(args);

        return Promise.resolve();
      },
    };

    await openService(SERVICE, context);
    await openService(SERVICE, context);

    assert.equal(forwards.length, 1);
  });

  it("reports a local port clash instead of forwarding over it", async () => {
    const message = await openService(SERVICE, {
      ...base,
      ssh: "me@clash",
      client: clientWith([SERVICE]),
      listening: () => Promise.resolve(true),
      forward: () => Promise.reject(new Error("must not run")),
    });

    assert.match(message, CLASH);
  });

  it("prints the URL when it cannot open a browser here", async () => {
    const message = await openService(SERVICE, {
      ...base,
      env: Object.fromEntries([["SSH_CONNECTION", "a b c d"]]),
      client: clientWith([SERVICE]),
    });

    assert.equal(message, "open http://127.0.0.1:3000 in a browser");
  });
});

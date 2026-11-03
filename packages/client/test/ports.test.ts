import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCwd,
  parseListeners,
  projectContaining,
  type RunTool,
  scanPorts,
} from "../src/ports.ts";

const projects = [
  { id: "web", name: "web", path: "/srv/web" },
  { id: "web-api", name: "api", path: "/srv/web/api" },
];

describe("parseListeners", () => {
  it("reads lsof -F output and keeps loopback and wildcard listeners only", () => {
    const out = [
      "p111",
      "cnode",
      "n127.0.0.1:3000",
      "n[::1]:3000",
      "p222",
      "cpostgres",
      "n*:5432",
      "p333",
      "cnginx",
      "n192.168.1.20:8080",
    ].join("\n");

    assert.deepEqual(parseListeners(out), [
      { pid: 111, command: "node", port: 3000 },
      { pid: 111, command: "node", port: 3000 },
      { pid: 222, command: "postgres", port: 5432 },
    ]);
  });

  it("ignores lines it does not understand", () => {
    assert.deepEqual(parseListeners("garbage\n\nnoise"), []);
  });
});

describe("parseCwd", () => {
  it("takes the n line", () => {
    assert.equal(parseCwd("p1\nfcwd\nn/srv/web/app\n"), "/srv/web/app");
    assert.equal(parseCwd(""), undefined);
  });
});

describe("projectContaining", () => {
  it("picks the deepest project that contains the folder", () => {
    assert.equal(projectContaining("/srv/web/api/src", projects)?.id, "web-api");
    assert.equal(projectContaining("/srv/web/app", projects)?.id, "web");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    assert.equal(projectContaining("/srv/website", projects), undefined);
    assert.equal(projectContaining("/elsewhere", projects), undefined);
  });
});

function fakeTools(): RunTool {
  return (command, args) => {
    if (command === "ps") {
      return Promise.resolve("Mon Nov  3 10:00:00 2026\n");
    }
    if (args.includes("-iTCP")) {
      return Promise.resolve(
        [
          "p10",
          "cvite",
          "n127.0.0.1:3000",
          "p20",
          "csomething",
          "n127.0.0.1:9999",
          "p30",
          "cmystery",
          "n127.0.0.1:7777",
        ].join("\n"),
      );
    }
    const pid = args[args.indexOf("-p") + 1];
    const folders: Record<string, string> = { "10": "/srv/web/app", "20": "/home/me/other" };

    return Promise.resolve(folders[pid ?? ""] ? `n${folders[pid ?? ""]}\n` : "");
  };
}

describe("scanPorts", () => {
  it("lists only ports whose process works inside a project, with its identity", async () => {
    const ports = await scanPorts(projects, fakeTools());

    assert.deepEqual(ports, [
      {
        port: 3000,
        command: "vite",
        folder: "/srv/web/app",
        projectId: "web",
        pid: 10,
        started: "Mon Nov  3 10:00:00 2026",
      },
    ]);
  });

  it("skips a process whose folder cannot be read instead of guessing", async () => {
    const ports = await scanPorts(projects, fakeTools());

    assert.ok(!ports.some((port) => port.port === 7777));
  });
});

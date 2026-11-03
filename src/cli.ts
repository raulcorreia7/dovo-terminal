#!/usr/bin/env node
import { parseArgs } from "node:util";
import { MockClient } from "./api/mock-client.ts";
import type { DovoClient } from "./api/client.ts";
import { loadConfig, resolveRuntime, saveConfig } from "./config.ts";
import { App } from "./tui/app.ts";
import { TaskListScreen } from "./tui/screens/tasklist.ts";

const USAGE = `dovo-terminal — Dovo Studio in the terminal

usage: dovo [options]
       dovo add <name> <url> [--token <token>]
       dovo token <token> [--profile <name>]

options:
  --url <url>        runtime address (default: saved profile)
  --token <token>    device token for this run
  --profile <name>   saved runtime profile
  --demo             offline demo against a scripted runtime
  -h, --help         this message

The Dovo runtime (apps/api or dovo-server) must already be running.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      profile: { type: "string" },
      demo: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const command = positionals[0];
  if (command === "add") {
    const [, name, url] = positionals;
    if (!name || !url) throw new Error("usage: dovo add <name> <url>");
    const config = loadConfig();
    config.runtimes[name] = { url, ...(values.token ? { token: values.token } : {}) };
    if (!config.current || config.current === "local") config.current = name;
    saveConfig(config);
    process.stdout.write(`saved runtime "${name}" → ${url}\n`);
    return;
  }
  if (command === "token") {
    const [, token] = positionals;
    if (!token) throw new Error("usage: dovo token <token>");
    const config = loadConfig();
    const name = values.profile ?? config.current;
    config.runtimes[name] = { ...(config.runtimes[name] ?? { url: "http://127.0.0.1:8787" }), token };
    saveConfig(config);
    process.stdout.write(`saved token for runtime "${name}"\n`);
    return;
  }

  let client: DovoClient;
  let title = "dovo-terminal";
  if (values.demo) {
    client = new MockClient();
    title += " (demo)";
  } else {
    const runtime = resolveRuntime({ url: values.url, token: values.token, profile: values.profile });
    const { createRuntimeClient } = await import("./api/runtime-client.ts");
    client = createRuntimeClient(runtime);
    title += ` — ${runtime.url}`;
  }

  const app = new App(client);
  process.title = title;
  await app.start(new TaskListScreen(app));
}

main().catch((error: unknown) => {
  process.stderr.write(`dovo-terminal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

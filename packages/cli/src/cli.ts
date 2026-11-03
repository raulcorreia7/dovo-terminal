#!/usr/bin/env node
// Wiring only: choose a backend (Dovo | demo), choose a route (local |
// loopback | existing server), hand the TUI a RuntimeClient. No mode reaches
// past the interface.
import { once } from "node:events";
import { parseArgs } from "node:util";
import { openRuntime, type RuntimeRoute } from "dovo-terminal/client/connect.ts";
import { createDemoClient } from "dovo-terminal/client/demo.ts";
import { createDovoClient } from "dovo-terminal/client/dovo.ts";
import type { RuntimeClient } from "dovo-terminal/client/runtime-client.ts";
import {
  DEFAULT_PRODUCTION_ORIGIN,
  loadConfig,
  type RuntimeProfile,
  resolveRuntime,
  saveConfig,
} from "dovo-terminal/config.ts";
import { errorMessage } from "dovo-terminal/protocol/errors.ts";
import { startRuntimeServer } from "dovo-terminal/server/index.ts";
import { App } from "dovo-terminal/tui/app.ts";
import { TaskListScreen } from "dovo-terminal/tui/screens/tasklist.ts";

const DEFAULT_SERVE_PORT = 8790;

const USAGE = `dovo-terminal — Dovo Studio in the terminal

usage: dovo [options]
       dovo serve [--port <n>] [backend options]   run only the local runtime server
       dovo add <name> <url> [--token <token>]
       dovo token <token> [--profile <name>]

backend options (pick one source):
  --url <url>        Dovo runtime address (default: saved profile)
  --token <token>    device token for this run
  --profile <name>   saved runtime profile
  --demo             scripted runtime, no Dovo required

route options (TUI runs the same either way):
  --server <url>     use an already-running "dovo serve" instance
  --local           no local server; the runtime is used in-process
  -h, --help         this message`;

interface Options {
  [key: string]: string | boolean | undefined;
  url?: string;
  token?: string;
  profile?: string;
  demo?: boolean;
  server?: string;
  local?: boolean;
  port?: string;
}

function buildBackend(values: Options): RuntimeClient {
  if (values.demo) {
    return createDemoClient();
  }
  const runtime = resolveRuntime({
    url: values.url,
    token: values.token,
    profile: values.profile,
  });
  return createDovoClient(runtime);
}

async function runServe(values: Options): Promise<void> {
  const backend = await buildBackend(values);
  const server = await startRuntimeServer({
    client: backend,
    port: Number(values.port ?? DEFAULT_SERVE_PORT),
  });
  process.stdout.write(
    `dovo runtime server on ${server.url}\n` +
      `connect with: dovo --server ${server.url}\nctrl+c to stop\n`,
  );
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await server.close();
}

async function runTerminal(values: Options): Promise<void> {
  let backend: RuntimeClient | null = null;
  if (!values.server) {
    backend = buildBackend(values);
  }
  const session = await openRuntime(backend, routeFor(values));
  const app = new App(session.client);
  process.title = `dovo-terminal (${describeBackend(values)})`;
  await app.start(new TaskListScreen(app));
}

/** What the process title reports about the chosen backend. */
function describeBackend(values: Options): string {
  if (values.server) {
    return values.server;
  }
  if (values.url) {
    return values.url;
  }
  if (values.demo) {
    return "demo";
  }
  return "runtime";
}

function routeFor(values: Options): RuntimeRoute {
  if (values.server) {
    return { via: "server", url: values.server } as const;
  }
  if (values.local) {
    return { via: "local" } as const;
  }
  return { via: "loopback" } as const;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      profile: { type: "string" },
      demo: { type: "boolean" },
      server: { type: "string" },
      local: { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  await dispatchCommand(positionals[0], values, positionals);
}

async function dispatchCommand(
  command: string | undefined,
  values: Options,
  positionals: string[],
): Promise<void> {
  if (command === "serve") {
    await runServe(values);
    return;
  }
  if (command === "add") {
    addRuntime(values, positionals);
    return;
  }
  if (command === "token") {
    addToken(values, positionals);
    return;
  }
  await runTerminal(values);
}

/** `dovo add`: remember a named runtime; the first one becomes current. */
function addRuntime(values: Options, positionals: string[]): void {
  const [, name, url] = positionals;
  if (!(name && url)) {
    throw new Error("usage: dovo add <name> <url>");
  }
  const config = loadConfig();
  const profile: RuntimeProfile = { url };
  if (values.token) {
    profile.token = values.token;
  }
  config.runtimes[name] = profile;
  if (!config.current || config.current === "local") {
    config.current = name;
  }
  saveConfig(config);
  process.stdout.write(`saved runtime "${name}" → ${url}\n`);
}

/** `dovo token`: attach an owner token to a runtime profile. */
function addToken(values: Options, positionals: string[]): void {
  const [, token] = positionals;
  if (!token) {
    throw new Error("usage: dovo token <token>");
  }
  const config = loadConfig();
  const name = values.profile ?? config.current;
  config.runtimes[name] = {
    ...(config.runtimes[name] ?? { url: DEFAULT_PRODUCTION_ORIGIN }),
    token,
  };
  saveConfig(config);
  process.stdout.write(`saved token for runtime "${name}"\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`dovo-terminal: ${errorMessage(error)}\n`);
  process.exit(1);
});

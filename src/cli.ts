#!/usr/bin/env node
// Wiring only: choose a backend (Dovo | demo), choose a route (direct |
// loopback | existing server), hand the TUI a RuntimeClient. No mode reaches
// past the interface.
import { once } from "node:events";
import { parseArgs } from "node:util";
import { openRuntime } from "./client/connect.ts";
import { createDovoClient } from "./client/dovo-client.ts";
import { type RuntimeClient } from "./client/runtime-client.ts";
import { DEFAULT_PRODUCTION_ORIGIN, loadConfig, resolveRuntime, saveConfig } from "./config.ts";
import { createDemoClient } from "./demo/runtime.ts";
import { startRuntimeServer } from "./server/index.ts";
import { App } from "./tui/app.ts";
import { TaskListScreen } from "./tui/screens/tasklist.ts";

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
  --direct           no local server; the runtime is used in-process
  -h, --help         this message`;

interface Options {
  [key: string]: string | boolean | undefined;
  url?: string;
  token?: string;
  profile?: string;
  demo?: boolean;
  server?: string;
  direct?: boolean;
  port?: string;
}

async function buildBackend(values: Options): Promise<RuntimeClient> {
  if (values.demo) return createDemoClient();
  const runtime = resolveRuntime({ url: values.url, token: values.token, profile: values.profile });
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
  const backend = values.server ? null : await buildBackend(values);
  const session = await openRuntime(backend, routeFor(values));
  const app = new App(session.client);
  process.title = `dovo-terminal (${values.server ?? values.url ?? (values.demo ? "demo" : "runtime")})`;
  await app.start(new TaskListScreen(app));
}

function routeFor(values: Options) {
  if (values.server) return { via: "server", url: values.server } as const;
  if (values.direct) return { via: "direct" } as const;
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
      direct: { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const command = positionals[0];
  if (command === "serve") return runServe(values);
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
    config.runtimes[name] = { ...(config.runtimes[name] ?? { url: DEFAULT_PRODUCTION_ORIGIN }), token };
    saveConfig(config);
    process.stdout.write(`saved token for runtime "${name}"\n`);
    return;
  }

  return runTerminal(values);
}

main().catch((error: unknown) => {
  process.stderr.write(`dovo-terminal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

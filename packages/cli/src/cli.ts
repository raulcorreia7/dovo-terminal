#!/usr/bin/env node
// Wiring only: choose a backend (Dovo | demo), choose a route (local |
// loopback | existing server), hand the TUI a RuntimeClient. No mode reaches
// past the interface.
import { once } from "node:events";
import { parseArgs } from "node:util";
import { startAgentServer } from "@dovo-terminal/a2a/server.ts";
import type { Machine } from "@dovo-terminal/client/federated.ts";
import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import { startRuntimeServer } from "@dovo-terminal/server/index.ts";
import { App } from "@dovo-terminal/tui/app.ts";
import { isListAction, type KeyOverrides } from "@dovo-terminal/tui/keys.ts";
import { TaskListScreen } from "@dovo-terminal/tui/screens/tasklist.ts";
import { openBackend } from "./backend.ts";
import { addRuntime, addToken, runDoctor, runPrune, showA2aToken } from "./commands.ts";
import { a2aTokenFor, dataPath, loadConfig, saveConfig, themesDir } from "./config.ts";
import { openRuntime, type RuntimeRoute } from "./connect.ts";
import { runChecks, targetsFor } from "./doctor.ts";
import { createGithubNotes } from "./github.ts";
import { isSafeWebhook, startTeamsNotifier } from "./notify.ts";
import type { Options } from "./options.ts";
import { runOrchestrate } from "./orchestrate.ts";
import { openService } from "./services.ts";
import { profileFor, shellForProject } from "./shell.ts";
import { loadUserThemes } from "./themes.ts";

const DEFAULT_SERVE_PORT = 8790;
const DEFAULT_A2A_PORT = 8791;

const USAGE = `dovo-terminal — Dovo Studio in the terminal

usage: dovo [options]
       dovo serve [--port <n>] [backend options]   run only the local runtime server
       dovo orchestrate [port] [--worker <name> | --planner <profile>]   spread goals over the A2A workers
       dovo a2a-token [--rotate]       show (or replace) this worker's A2A access token
       dovo doctor [backend options]   check every machine; exit 1 if anything fails
       dovo prune --older <30d|12h> [--yes] [backend options]   delete old archived tasks (dry run unless --yes)
       dovo add <name> <url> [--token <token>] [--ssh <user@host>] [--agent]   (ssh: managed tunnel; agent: it is an A2A worker)
       dovo token <token> [--profile <name>]

backend options (pick one source):
  --url <url>        Dovo runtime address (default: saved profile)
  --token <token>    device token for this run
  --profile <name>   saved runtime profile
  --all              every saved runtime at once, as one workspace
  --a2a <port>       (serve) also expose an A2A agent; calls need a bearer token (DOVO_A2A_TOKEN, else one is made)
  --demo             scripted runtime, no Dovo required

display options:
  --theme <name>     colour theme (default: saved choice, else auto); press t in the task list
                     lists them. Your own live in ~/.config/dovo-terminal/themes/*.json

route options (TUI runs the same either way):
  --server <url>     use an already-running "dovo serve" instance
  --local           no local server; the runtime is used in-process
  -h, --help         this message`;

async function runServe(values: Options): Promise<void> {
  const { client: backend } = await openBackend(values);
  watchTeams(backend, loadConfig().teamsWebhook);
  const server = await startRuntimeServer({
    client: backend,
    port: Number(values.port ?? DEFAULT_SERVE_PORT),
  });
  process.stdout.write(
    `dovo runtime server on ${server.url}\n` +
      `connect with: dovo --server ${server.url}\nctrl+c to stop\n`,
  );
  const agent = await maybeServeAgent(backend, values);
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await agent?.close();
  await server.close();
}

/** `dovo serve --a2a [port]`: let other agents delegate tasks to this runtime. */
async function maybeServeAgent(backend: RuntimeClient, values: Options) {
  if (values.a2a === undefined) {
    return null;
  }
  const config = loadConfig();
  const agent = await startAgentServer({
    client: backend,
    port: Number(values.a2a || DEFAULT_A2A_PORT),
    token: a2aTokenFor(config, process.env["DOVO_A2A_TOKEN"]),
    dbPath: dataPath("a2a.db"),
    allow: config.a2aAllow,
    ...(config.a2aPublicUrl && { publicUrl: config.a2aPublicUrl }),
  });
  process.stdout.write(
    `A2A agent on ${agent.url} (card: ${agent.url}/.well-known/agent-card.json)\n` +
      "callers send  Authorization: Bearer <token>   (show it with: dovo a2a-token)\n",
  );

  return agent;
}

async function runTerminal(values: Options): Promise<void> {
  let backend: RuntimeClient | null = null;
  let machines: Machine[] = [];
  if (!values.server) {
    const opened = await openBackend(values);
    backend = opened.client;
    machines = opened.machines;
  }
  const session = await openRuntime(backend, routeFor(values));
  const config = loadConfig();
  watchTeams(session.client, config.teamsWebhook);
  const { themes, problems } = loadUserThemes(themesDir());
  const app = new App(session.client, {
    themes,
    theme: values.theme ?? config.theme ?? "auto",
    onThemeChange: saveThemeChoice,
    keys: validKeys(config.keys ?? {}),
    shellFor: (project) => shellForProject(project, values, config),
    checkMachines: () => runChecks(targetsFor(machines, config)),
    openPort: (port) =>
      openService(port, {
        client: session.client,
        ssh: profileFor(port.projectId, values, config)?.ssh,
      }),
    ...(config.github && { projectNote: createGithubNotes() }),
  });
  app.statusNote = problems[0] ?? app.statusNote;
  process.title = `dovo-terminal (${describeBackend(values)})`;
  await app.start(new TaskListScreen(app));
}

/** Post to Teams when configured (config `teamsWebhook`, or env DOVO_TEAMS_WEBHOOK). */
function watchTeams(client: RuntimeClient, saved: string | undefined): void {
  const webhook = process.env["DOVO_TEAMS_WEBHOOK"] ?? saved;
  if (!webhook) {
    return;
  }
  if (isSafeWebhook(webhook)) {
    startTeamsNotifier(client, webhook); // runs until the process exits
  } else {
    process.stderr.write("dovo-terminal: teams webhook ignored (it must be an https URL)\n");
  }
}

/** The configured keys that name a real action; unknown names are ignored. */
function validKeys(configured: Record<string, string>): KeyOverrides {
  return Object.fromEntries(Object.entries(configured).filter(([action]) => isListAction(action)));
}

/** Remember the theme picked in the app (a --theme flag only applies to one run). */
function saveThemeChoice(setting: string): void {
  const config = loadConfig();
  config.theme = setting;
  saveConfig(config);
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
      theme: { type: "string" },
      all: { type: "boolean" },
      a2a: { type: "string" },
      older: { type: "string" },
      yes: { type: "boolean" },
      rotate: { type: "boolean" },
      agent: { type: "boolean" },
      planner: { type: "string" },
      worker: { type: "string" },
      ssh: { type: "string" },
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
  if (command === "orchestrate") {
    await runOrchestrate(values, positionals[1]);
    return;
  }
  if (command === "a2a-token") {
    showA2aToken(values);
    return;
  }
  if (command === "doctor") {
    await runDoctor(values);
    return;
  }
  if (command === "prune") {
    await runPrune(values);
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

main().catch((error: unknown) => {
  process.stderr.write(`dovo-terminal: ${errorMessage(error)}\n`);
  process.exit(1);
});

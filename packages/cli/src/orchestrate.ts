// `dovo orchestrate <port>`: serve an orchestrator over A2A that spreads goals
// across the saved A2A workers (profiles added with `--agent`).
import { once } from "node:events";
import { harnessPlanner, type Planner, singleWorker } from "@dovo-terminal/orchestrator/planner.ts";
import { startOrchestrator } from "@dovo-terminal/orchestrator/server.ts";
import { agentWorkers, openBackend } from "./backend.ts";
import { a2aTokenFor, dataPath, loadConfig } from "./config.ts";
import type { Options } from "./options.ts";

const DEFAULT_ORCHESTRATOR_PORT = 8792;

/** The planner the flags ask for: an agent on a Dovo runtime, or one named worker, or the only one. */
async function plannerFor(values: Options, workerNames: readonly string[]): Promise<Planner> {
  if (values.planner) {
    const { client } = await openBackend({ profile: values.planner });
    const [project] = await client.listProjects();
    const [provider] = await client.listProviders();
    if (!(project && provider)) {
      throw new Error(`"${values.planner}" has no project or agent to plan with`);
    }

    return harnessPlanner(client, { projectId: project.id, providerId: provider.id });
  }
  const only = values.worker ?? (workerNames.length === 1 ? workerNames[0] : undefined);
  if (!only) {
    throw new Error(
      "several workers: pick one with --worker <name>, or plan with an agent via --planner <profile>",
    );
  }
  if (!workerNames.includes(only)) {
    throw new Error(`no worker named "${only}"`);
  }

  return singleWorker(only);
}

export async function runOrchestrate(values: Options, portText: string | undefined): Promise<void> {
  const workers = await agentWorkers();
  const names = Object.keys(workers);
  if (names.length === 0) {
    throw new Error("no workers: add one with  dovo add <name> <url> --agent --token <t>");
  }
  const config = loadConfig();
  const server = await startOrchestrator({
    planner: await plannerFor(values, names),
    workers,
    port: Number(portText ?? DEFAULT_ORCHESTRATOR_PORT),
    token: a2aTokenFor(config, process.env["DOVO_A2A_TOKEN"]),
    dbPath: dataPath("orchestrator.db"),
    ...(config.a2aPublicUrl && { publicUrl: config.a2aPublicUrl }),
  });
  process.stdout.write(
    `orchestrator on ${server.url} with workers: ${names.join(", ")}\n` +
      "callers send  Authorization: Bearer <token>   (show it with: dovo a2a-token)\nctrl+c to stop\n",
  );
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await server.close();
}

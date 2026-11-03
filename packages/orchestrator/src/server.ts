import { type RunningAgentServer, serveAgent } from "@dovo-terminal/a2a/server.ts";
import type { Worker } from "./dispatch.ts";
import { OrchestratorExecutor } from "./executor.ts";
import type { Planner } from "./planner.ts";

export interface OrchestratorServerOptions {
  planner: Planner;
  workers: Readonly<Record<string, Worker>>;
  port?: number | undefined;
  hostname?: string | undefined;
  token?: string | undefined;
  dbPath?: string | undefined;
  publicUrl?: string | undefined;
}

/** The orchestrator, reachable like any worker: send it a goal over A2A. */
export function startOrchestrator(options: OrchestratorServerOptions): Promise<RunningAgentServer> {
  return serveAgent({
    ...options,
    who: {
      name: "Dovo Orchestrator",
      description: "Splits a goal into steps and runs them on its workers. Send the goal as text.",
      skill: {
        id: "orchestrate",
        name: "Run a goal across workers",
        description: "Plans the goal, delegates the steps, and reports one result.",
        examples: ["Add input validation to the API and update its docs"],
      },
    },
    executorFor: (store) =>
      new OrchestratorExecutor({ planner: options.planner, workers: options.workers, store }),
  });
}

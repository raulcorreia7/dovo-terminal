// `dovo doctor --deep`: ask each expected agent a one-line question and see that it
// answers. This spends model budget, so it only runs when asked for by name.

import { delegateAndFollow, type Worker } from "@dovo-terminal/orchestrator/dispatch.ts";
import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import type { Check } from "@dovo-terminal/tui/checks.ts";

const PROMPT = "Reply with the single word: ok. Do not use any tools or change any files.";
const ANSWER_WITHIN_MS = 120_000;

export interface DeepTarget {
  name: string;
  client: Pick<
    RuntimeClient,
    "listProjects" | "listProviders" | "createTask" | "subscribe" | "stopTask" | "deleteTask"
  >;
  /** The agents to try: those the config says every machine should offer. */
  expect: readonly string[];
}

/** Whether a provider (id or label) is the agent named in `expect`. */
function matches(provider: { id: string; label: string }, wanted: string): boolean {
  const name = wanted.toLowerCase();

  return provider.id.toLowerCase().includes(name) || provider.label.toLowerCase().includes(name);
}

async function tryAgent(
  target: DeepTarget,
  provider: { id: string; label: string },
  projectId: string,
): Promise<Check> {
  const worker: Worker = {
    subscribe: (listener) => target.client.subscribe(listener),
    stopTask: (taskId) => target.client.stopTask(taskId),
    delegate: (prompt) => target.client.createTask({ projectId, providerId: provider.id, prompt }),
  };
  const name = `try ${provider.label}`;
  try {
    const answer = await delegateAndFollow(worker, PROMPT, {
      signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
    });
    // the throwaway task is ours; remove it rather than leave clutter on the machine
    await target.client.deleteTask(answer.taskId).catch(() => undefined);
    if (answer.state === "done" || answer.state === "needs-input") {
      return { machine: target.name, name, ok: true, detail: "answered" };
    }

    return {
      machine: target.name,
      name,
      ok: false,
      detail: answer.state === "cancelled" ? "no answer within 2 minutes" : "it reported an error",
      next: "run it by hand on that machine to see why",
    };
  } catch (error) {
    return {
      machine: target.name,
      name,
      ok: false,
      detail: errorMessage(error),
      next: "check the agent is installed and signed in",
    };
  }
}

/** One question per expected agent, per machine. Machines are asked one after another. */
export async function deepChecks(targets: readonly DeepTarget[]): Promise<Check[]> {
  const perMachine = await Promise.all(
    targets.map(async (target): Promise<Check[]> => {
      if (target.expect.length === 0) {
        return [
          {
            machine: target.name,
            name: "deep",
            ok: false,
            detail: "no agents to try",
            next: 'list them in the config: "expect": ["codex"]',
          },
        ];
      }
      try {
        const [project] = await target.client.listProjects();
        const providers = await target.client.listProviders();
        if (!project) {
          return [
            {
              machine: target.name,
              name: "deep",
              ok: false,
              detail: "no project to try them in",
              next: "add a project on that machine",
            },
          ];
        }
        const chosen = target.expect.flatMap((wanted) =>
          providers.filter((provider) => matches(provider, wanted)).slice(0, 1),
        );

        return await Promise.all(chosen.map((provider) => tryAgent(target, provider, project.id)));
      } catch (error) {
        return [
          {
            machine: target.name,
            name: "deep",
            ok: false,
            detail: errorMessage(error),
            next: "fix the runtime check above first",
          },
        ];
      }
    }),
  );

  return perMachine.flat();
}

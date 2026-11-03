// Picking up a plan an earlier run left unfinished: finished steps keep the result
// they had, and a step that had started is looked at on its worker, never created again.
import type { SavedStep } from "@dovo-terminal/a2a/store.ts";
import type { Delegated, RunOptions, StepResult, StepState, Worker } from "./dispatch.ts";
import type { Step } from "./plan.ts";

const DEFAULT_POLL_MS = 2000;

/** A step that already finished in an earlier run, as the result it had. */
export function savedResult(step: Step, saved: SavedStep): StepResult {
  return {
    id: step.id,
    worker: step.worker,
    state: saved.state as StepState,
    text: saved.text ?? "",
    ...(saved.workerTaskId && { taskId: saved.workerTaskId }),
  };
}

/**
 * Pick up a task an earlier run already started. It is looked at, never created
 * again: where it stands now decides the outcome, and a task still running is
 * checked until it stops.
 */
export async function resumeFollow(
  worker: Worker,
  taskId: string,
  options: RunOptions,
): Promise<Delegated> {
  if (!worker.getTaskHistory) {
    return { taskId, state: "failed", text: "this worker cannot report on a task after a restart" };
  }
  const wait = options.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
    const history = await worker.getTaskHistory(taskId);
    const said = history.items
      .flatMap((item) => (item.kind === "assistant" ? [item.text] : []))
      .join("\n\n");
    if (history.status === "idle") {
      return { taskId, state: "done", text: said };
    }
    if (history.status === "error") {
      return {
        taskId,
        state: "failed",
        text: [said, "the worker reported an error"].filter(Boolean).join("\n\n"),
      };
    }
    if (history.status === "waiting") {
      return {
        taskId,
        state: "needs-input",
        text: [said, `waiting for input on task ${taskId}; answer it on that worker`]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    if (options.signal?.aborted) {
      void worker.stopTask(taskId).catch(() => undefined);

      return { taskId, state: "cancelled", text: "cancelled" };
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

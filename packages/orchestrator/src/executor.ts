// The orchestrator as an A2A agent: it takes a goal, asks the planner for a
// plan, validates it, runs it on the workers, and reports one result. It never
// answers an approval; a step that needs input is reported as input required.
import { type Message, type Task, TaskState } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { agentMessage, textOf } from "@dovo-terminal/a2a/a2a-text.ts";
import type { WorkerStore } from "@dovo-terminal/a2a/store.ts";
import { DovoError, errorMessage } from "@dovo-terminal/protocol/errors.ts";
import { runPlan, type StepResult, type Worker } from "./dispatch.ts";
import { validatePlan } from "./plan.ts";
import type { Planner } from "./planner.ts";

/** How many orchestrators deep a goal may travel before it is refused. */
export const MAX_HOPS = 3;

export interface OrchestratorOptions {
  planner: Planner;
  workers: Readonly<Record<string, Worker>>;
  store: WorkerStore;
}

interface Verdict {
  state: TaskState;
  text: string;
}

/** One line per step, then the overall state they add up to. */
export function summarise(results: readonly StepResult[]): Verdict {
  const lines = results.map((result) => {
    const first = result.text.split("\n")[0]?.slice(0, 300) ?? "";

    return `${result.id} @${result.worker}: ${result.state}${first ? ` — ${first}` : ""}`;
  });
  const states = new Set(results.map((result) => result.state));
  let state = TaskState.TASK_STATE_COMPLETED;
  if (states.has("failed") || states.has("skipped")) {
    state = TaskState.TASK_STATE_FAILED;
  } else if (states.has("needs-input")) {
    state = TaskState.TASK_STATE_INPUT_REQUIRED;
  } else if (states.has("cancelled")) {
    state = TaskState.TASK_STATE_CANCELED;
  }

  return { state, text: lines.join("\n") };
}

function hopsOf(message: Message | undefined): number {
  const hops = message?.metadata?.["hops"];

  return typeof hops === "number" && Number.isFinite(hops) ? hops : 0;
}

export class OrchestratorExecutor implements AgentExecutor {
  private readonly options: OrchestratorOptions;
  private readonly running = new Map<string, AbortController>();
  private readonly contexts = new Map<string, string>();

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = context;
    this.contexts.set(taskId, contextId);
    const task: Task = context.task ?? {
      id: taskId,
      contextId,
      status: undefined,
      artifacts: [],
      history: context.request.message ? [context.request.message] : [],
      metadata: undefined,
    };
    bus.publish(
      AgentEvent.task({
        ...task,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
      }),
    );
    const verdict = await this.attempt(context, bus);
    if (verdict.state !== TaskState.TASK_STATE_CANCELED) {
      this.report(bus, taskId, contextId, verdict);
    }
    bus.finished();
  }

  cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.running.get(taskId)?.abort();
    this.report(bus, taskId, this.contexts.get(taskId) ?? "", {
      state: TaskState.TASK_STATE_CANCELED,
      text: "",
    });
    bus.finished();

    return Promise.resolve();
  }

  stopAll(): void {
    for (const controller of this.running.values()) {
      controller.abort();
    }
  }

  private async attempt(context: RequestContext, bus: ExecutionEventBus): Promise<Verdict> {
    const { taskId, contextId } = context;
    const message = context.request.message;
    try {
      const goal = textOf(message);
      if (!goal) {
        throw new DovoError("send a goal as text");
      }
      if (hopsOf(message) >= MAX_HOPS) {
        throw new DovoError(
          `refused: this goal has already passed through ${MAX_HOPS} orchestrators`,
        );
      }
      const messageId = message?.messageId ?? "";
      // A goal received before is carried on from where it stopped, never started over.
      const earlier = messageId ? await this.options.store.taskOfMessage(messageId) : undefined;
      const origin = earlier ?? taskId;
      const saved = earlier ? await this.options.store.loadPlan(earlier) : undefined;
      if (earlier && !saved) {
        throw new DovoError(
          "this goal was received but never planned; send it again as a new message",
        );
      }
      if (messageId && !earlier) {
        await this.options.store.recordMessage(messageId, taskId);
      }
      const names = Object.keys(this.options.workers);
      const plan = validatePlan(
        saved ? JSON.parse(saved) : await this.options.planner(goal, names),
        names,
      );
      if (!saved) {
        await this.options.store.savePlan(origin, JSON.stringify(plan));
      }
      const controller = new AbortController();
      this.running.set(taskId, controller);
      const results = await runPlan(plan, this.options.workers, {
        hops: hopsOf(message),
        signal: controller.signal,
        resume: await this.options.store.loadSteps(origin),
        onStarted: (stepId, workerTaskId) =>
          this.options.store.saveStep(origin, stepId, { workerTaskId }),
        onStep: async (step) => {
          await this.options.store.saveStep(origin, step.id, {
            state: step.state,
            text: step.text,
            workerTaskId: step.taskId ?? null,
          });
          this.progress(bus, taskId, contextId, step);
        },
      });

      return summarise(results);
    } catch (error) {
      return { state: TaskState.TASK_STATE_FAILED, text: errorMessage(error) };
    } finally {
      this.running.delete(taskId);
    }
  }

  private progress(
    bus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    step: StepResult,
  ): void {
    this.report(bus, taskId, contextId, {
      state: TaskState.TASK_STATE_WORKING,
      text: `step ${step.id} on ${step.worker}: ${step.state}`,
    });
  }

  private report(
    bus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    verdict: Verdict,
  ): void {
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: verdict.state,
          message: verdict.text ? agentMessage(verdict.text, contextId, taskId) : undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
  }
}

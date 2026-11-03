// Maps A2A onto a RuntimeClient. One A2A task is one Dovo task: the first
// message creates it, a later message to the same A2A task continues it. A Dovo
// task that needs an approval or answer is A2A "input required"; one that
// settles is "completed". The SDK does the rest.
//
// What the worker guarantees, and how:
//  - A redelivered message never repeats its effect: ids are stored before acting.
//  - A crash between "about to create" and "created" is reported as ambiguous,
//    never answered by creating a second task.
//  - A caller can only name projects and agents on the allowlist (if one is set).
import { type Message, type Task, TaskState } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { DovoError, errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import type { ConversationItem } from "@dovo-terminal/protocol/workspace.ts";
import {
  agentMessage,
  assistantText,
  endingState,
  type PendingApproval,
  pendingApprovals,
  remember,
  textOf,
} from "./a2a-text.ts";
import { assertAllowed, firstChoice } from "./choices.ts";
import type { Run, WorkerStore } from "./store.ts";

export interface ExecutorOptions {
  /** Project new tasks run in; the first the runtime lists if absent. */
  projectId?: string | undefined;
  /** Agent new tasks use; the first the runtime lists if absent. */
  providerId?: string | undefined;
  /** If set, callers may only use these projects / agents. */
  allow?: { projects?: string[] | undefined; providers?: string[] | undefined } | undefined;
  /** Most turns followed at once; further requests are refused, not queued. */
  maxActive?: number | undefined;
  /** How long to follow one turn before reporting it as still running. */
  turnTimeoutMs?: number | undefined;
}

const AMBIGUOUS =
  "an earlier attempt may have created this task; check the runtime before retrying";
const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

interface Outcome {
  state: TaskState;
  text: string;
  /** Approvals waiting on a person, when the turn ended asking. */
  approvals?: PendingApproval[];
}

export class DovoExecutor implements AgentExecutor {
  private readonly client: RuntimeClient;
  private readonly store: WorkerStore;
  private readonly options: ExecutorOptions;
  /** Ends the wait for a task's current turn, used by cancel. */
  private readonly interrupts = new Map<string, () => void>();
  /** Context ids, so a cancel can report the right one. */
  private readonly contexts = new Map<string, string>();
  private active = 0;

  constructor(client: RuntimeClient, store: WorkerStore, options: ExecutorOptions = {}) {
    this.client = client;
    this.store = store;
    this.options = options;
  }

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = context;
    this.contexts.set(taskId, contextId);
    this.announce(context, bus);
    const outcome = await this.guarded(context);
    this.finish(bus, taskId, contextId, outcome);
    bus.finished();
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const run = await this.store.runOf(taskId);
    let note = "";
    if (run?.dovoTaskId) {
      try {
        await this.client.stopTask(run.dovoTaskId);
      } catch (error) {
        note = `the run may still be going: ${errorMessage(error)}`;
      }
    }
    this.interrupts.get(taskId)?.();
    const contextId = this.contexts.get(taskId) ?? "";
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: note ? agentMessage(note, contextId, taskId) : undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    bus.finished();
  }

  /** End every turn being followed, so shutdown does not leave work writing to a closed store. */
  stopAll(): void {
    for (const interrupt of [...this.interrupts.values()]) {
      interrupt();
    }
  }

  /** Refuse when busy, then turn any failure into a failed task with a readable reason. */
  private async guarded(context: RequestContext): Promise<Outcome> {
    const limit = this.options.maxActive ?? DEFAULT_MAX_ACTIVE;
    if (this.active >= limit) {
      return {
        state: TaskState.TASK_STATE_FAILED,
        text: `worker busy: ${limit} turns already running`,
      };
    }
    this.active += 1;
    try {
      return await this.run(context);
    } catch (error) {
      return { state: TaskState.TASK_STATE_FAILED, text: errorMessage(error) };
    } finally {
      this.active -= 1;
    }
  }

  private async run(context: RequestContext): Promise<Outcome> {
    const { taskId } = context;
    const message = context.request.message;
    const text = textOf(message);
    if (!text) {
      throw new DovoError("send a text message describing the work");
    }
    const messageId = message?.messageId ?? "";
    const seen = messageId ? await this.store.taskOfMessage(messageId) : undefined;
    // A retried first message arrives without a task id, so the SDK numbers it
    // afresh; the run to look at is the one the message first belonged to.
    const run = await this.store.runOf(seen ?? taskId);
    if (seen && run) {
      return await this.report(taskId, run);
    }
    if (messageId && !seen) {
      await this.store.recordMessage(messageId, taskId);
    }
    if (run && !run.dovoTaskId) {
      throw new DovoError(AMBIGUOUS);
    }
    const dovoTaskId = run?.dovoTaskId ?? (await this.create(context, text));
    if (run?.dovoTaskId) {
      await this.deliver(dovoTaskId, message);
    }

    return await this.waitForTurn(taskId, dovoTaskId);
  }

  /** A follow-up either answers a pending approval by id (typed) or is plain chat. */
  private async deliver(dovoTaskId: string, message: Message | undefined): Promise<void> {
    const answering = message?.metadata?.["answerItem"];
    if (typeof answering === "string") {
      await this.client.answerItem(
        dovoTaskId,
        answering,
        String(message?.metadata?.["answer"] ?? ""),
      );
    } else {
      await this.client.sendMessage(dovoTaskId, textOf(message));
    }
  }

  /** A message seen before: say where its task stands instead of repeating anything. */
  private async report(taskId: string, run: Run): Promise<Outcome> {
    if (!run.dovoTaskId) {
      throw new DovoError(AMBIGUOUS);
    }
    const known = (await this.client.listTasks()).find((task) => task.id === run.dovoTaskId);
    if (!known) {
      throw new DovoError("the task no longer exists on the runtime");
    }
    if (known.status === "running") {
      return await this.waitForTurn(taskId, run.dovoTaskId);
    }

    return {
      state: endingState(known.status) ?? TaskState.TASK_STATE_COMPLETED,
      text: "already handled",
    };
  }

  private async create(context: RequestContext, text: string): Promise<string> {
    const asked = context.request.message?.metadata ?? {};
    const projectId = String(
      asked["projectId"] ?? this.options.projectId ?? (await firstChoice(this.client, "project")),
    );
    const providerId = String(
      asked["providerId"] ?? this.options.providerId ?? (await firstChoice(this.client, "agent")),
    );
    assertAllowed(this.options.allow, projectId, providerId);
    await this.store.beginRun(context.taskId);
    const created = await this.client.createTask({ projectId, providerId, prompt: text });
    await this.store.attachRun(context.taskId, created.id);

    return created.id;
  }

  /** The SDK requires a task (or message) as the first event of every turn. */
  private announce(context: RequestContext, bus: ExecutionEventBus): void {
    const history = context.request.message ? [context.request.message] : [];
    const task: Task = context.task ?? {
      id: context.taskId,
      contextId: context.contextId,
      status: undefined,
      artifacts: [],
      history,
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
  }

  /**
   * Follow the Dovo task until this turn ends: it settles (completed), needs
   * you (input required), fails, is cancelled, or runs past the time limit.
   */
  private waitForTurn(taskId: string, dovoTaskId: string): Promise<Outcome> {
    const items = new Map<string, ConversationItem>();
    const limit = this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    return new Promise<Outcome>((resolve) => {
      const done = (state: TaskState, text = assistantText(items)) => {
        clearTimeout(timer);
        unsubscribe();
        this.interrupts.delete(taskId);
        resolve({ state, text, approvals: pendingApprovals(items) });
      };
      const timer = setTimeout(
        () =>
          done(TaskState.TASK_STATE_FAILED, "still running after the time limit; follow up later"),
        limit,
      );
      const unsubscribe = this.client.subscribe((frame) => {
        if (frame.type !== "event" || frame.event.taskId !== dovoTaskId) {
          return;
        }
        const state = remember(items, frame.event);
        if (state !== undefined) {
          done(state);
        }
      });
      this.interrupts.set(taskId, () => done(TaskState.TASK_STATE_CANCELED));
    });
  }

  private finish(
    bus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    outcome: Outcome,
  ): void {
    if (outcome.state === TaskState.TASK_STATE_CANCELED) {
      return; // cancelTask already reported it
    }
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: outcome.state,
          message:
            outcome.text || outcome.approvals?.length
              ? agentMessage(
                  outcome.text,
                  contextId,
                  taskId,
                  outcome.approvals?.length ? { approvals: outcome.approvals } : undefined,
                )
              : undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
  }
}

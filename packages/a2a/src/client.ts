// A worker reached over A2A, presented to the terminal as a RuntimeClient. A2A
// is task-oriented: it can create and follow work, ask for input, and cancel,
// but it has no catalogue of projects or agents and no ability to list devices,
// ports or archives. So this client offers the core, one stand-in project and
// agent (the worker decides the real ones), and none of the optional abilities.
import type { Message, StreamResponse, Task } from "@a2a-js/sdk";
import {
  type Client,
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import { ConnectionStateMachine } from "@dovo-terminal/protocol/connection-state.ts";
import { DovoError, errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import type { ConnectionPhase, SyncListener, Unsubscribe } from "@dovo-terminal/protocol/sync.ts";
import { SyncSink } from "@dovo-terminal/protocol/sync-sink.ts";
import type {
  AgentProvider,
  ConversationItem,
  CreateTaskInput,
  ModelOption,
  Project,
  TaskHistory,
  TaskSummary,
} from "@dovo-terminal/protocol/workspace.ts";
import { TASK_TITLE_MAX_CHARS } from "@dovo-terminal/protocol/workspace.ts";
import { textOf } from "./a2a-text.ts";
import { conversationOf, itemsOf, statusOf, userMessage } from "./mapping.ts";

/** The one project and agent this client offers: the worker chooses the real ones. */
export const AGENT_ID = "agent";

/** A worker reached over A2A: the core RuntimeClient plus handing off a piece of work. */
export interface AgentClient extends RuntimeClient {
  /** Start a task from a prompt, with optional metadata for the worker. */
  delegate(prompt: string, metadata?: Record<string, unknown>): Promise<TaskSummary>;
}

export interface AgentClientOptions {
  /** The worker's base address, as configured by the user. */
  url: string;
  token: string;
  /** What to call it; the agent card's name if absent. */
  name?: string;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * A `fetch` that only ever talks to the configured origin and always carries the
 * token. An agent card may name any address for its endpoint; honouring that
 * would send the token wherever a hostile card pointed. Here the card's path is
 * kept and its host is not.
 */
export function pinnedFetch(
  base: string,
  token: string,
  inner: typeof fetch = fetch,
): typeof fetch {
  const origin = new URL(base);

  return (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const requested = new URL(original?.url ?? (input instanceof URL ? input.href : String(input)));
    const target = new URL(`${requested.pathname}${requested.search}`, origin);
    const headers = new Headers(init?.headers ?? original?.headers);
    headers.set("authorization", `Bearer ${token}`);
    const request = original ? new Request(target, original) : target;

    return inner(request, { ...init, headers });
  };
}

class AgentRuntimeClient implements AgentClient {
  private readonly client: Client;
  private readonly agentName: string;
  private readonly sink = new SyncSink();
  private readonly connection = new ConnectionStateMachine();
  private readonly tasks = new Map<string, TaskSummary>();
  private readonly contexts = new Map<string, string>();

  constructor(client: Client, agentName: string) {
    this.client = client;
    this.agentName = agentName;
  }

  subscribe(listener: SyncListener): Unsubscribe {
    return this.sink.subscribe(listener);
  }

  connect(): void {
    void this.client.getAgentCard().then(
      () => this.setPhase("online"),
      () => this.setPhase("offline"),
    );
  }

  close(): void {
    this.setPhase("offline");
    this.sink.clear();
  }

  focusTask(): void {
    // nothing to retarget: A2A pushes only what this client asked to follow
  }

  listProjects(): Promise<Project[]> {
    return Promise.resolve([{ id: AGENT_ID, name: this.agentName, path: "" }]);
  }

  listProviders(): Promise<AgentProvider[]> {
    return Promise.resolve([{ id: AGENT_ID, label: this.agentName }]);
  }

  listModels(): Promise<ModelOption[]> {
    return Promise.resolve([]);
  }

  /** The tasks this client has started or followed; A2A has no portable list to ask for. */
  listTasks(): Promise<TaskSummary[]> {
    return Promise.resolve([...this.tasks.values()].map((task) => ({ ...task })));
  }

  async getTaskHistory(taskId: string): Promise<TaskHistory> {
    const task = await this.client.getTask({ tenant: "", id: taskId, historyLength: 200 });
    this.note(task);

    return { items: conversationOf(task), status: statusOf(task.status?.state) };
  }

  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const metadata: Record<string, unknown> = {};
    if (input.projectId !== AGENT_ID) {
      metadata["projectId"] = input.projectId;
    }
    if (input.providerId !== AGENT_ID) {
      metadata["providerId"] = input.providerId;
    }

    return await this.delegate(input.prompt, metadata);
  }

  async delegate(prompt: string, metadata: Record<string, unknown> = {}): Promise<TaskSummary> {
    return await this.send(userMessage(prompt, { metadata }), undefined);
  }

  async sendMessage(taskId: string, text: string): Promise<void> {
    await this.send(userMessage(text, this.within(taskId)), taskId);
  }

  async stopTask(taskId: string): Promise<void> {
    this.note(await this.client.cancelTask({ tenant: "", id: taskId, metadata: undefined }));
  }

  setTaskArchived(): Promise<void> {
    return Promise.reject(
      new DovoError("an A2A worker keeps no archive; stop or delete on the worker"),
    );
  }

  deleteTask(): Promise<void> {
    return Promise.reject(new DovoError("an A2A worker cannot delete tasks; do it on the worker"));
  }

  /** Answer an approval by id; the worker applies it to the run that asked. */
  async answerItem(taskId: string, itemId: string, answer: string): Promise<void> {
    const metadata = { answerItem: itemId, answer };
    await this.send(userMessage(answer || itemId, { ...this.within(taskId), metadata }), taskId);
  }

  private within(taskId: string): { taskId: string; contextId: string } {
    return { taskId, contextId: this.contexts.get(taskId) ?? "" };
  }

  /**
   * Send a message and follow the reply stream. Resolves once the task is known,
   * with the rest of the stream delivered as events in the background.
   */
  private async send(message: Message, known: string | undefined): Promise<TaskSummary> {
    const stream = this.client.sendMessageStream({
      tenant: "",
      message,
      configuration: undefined,
      metadata: undefined,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const id = first.done ? known : this.take(first.value, message);
    if (!id) {
      throw new DovoError("the worker did not start a task");
    }
    void this.pump({ [Symbol.asyncIterator]: () => iterator }, message);
    const summary = this.tasks.get(id);
    if (!summary) {
      throw new DovoError("the worker did not report a task");
    }

    return { ...summary };
  }

  private async pump(rest: AsyncIterable<StreamResponse>, sent: Message): Promise<void> {
    try {
      for await (const update of rest) {
        this.take(update, sent);
      }
    } catch (error) {
      this.setPhase("reconnecting");
      this.say(sent.taskId, `connection to the worker was lost: ${errorMessage(error)}`);
    }
  }

  /** Apply one streamed update; returns the id of the task it concerns, if it names one. */
  private take(update: StreamResponse, sent: Message): string | undefined {
    const payload = update.payload;
    if (payload?.$case === "task") {
      this.note(payload.value, sent);
      this.status(payload.value.id, statusOf(payload.value.status?.state));

      return payload.value.id;
    }
    if (payload?.$case === "statusUpdate") {
      const { taskId, status } = payload.value;
      this.status(taskId, statusOf(status?.state));
      for (const item of itemsOf(status?.message)) {
        this.append(taskId, item);
      }

      return taskId;
    }
    if (payload?.$case === "message") {
      for (const item of itemsOf(payload.value)) {
        this.append(payload.value.taskId, item);
      }

      return payload.value.taskId;
    }

    return undefined;
  }

  /** Record or refresh a task's summary from what the worker reported. */
  private note(task: Task, sent?: Message): void {
    this.contexts.set(task.id, task.contextId);
    const title = this.tasks.get(task.id)?.title ?? titleOf(sent ?? task.history[0]);
    this.tasks.set(task.id, {
      id: task.id,
      projectId: AGENT_ID,
      title,
      status: statusOf(task.status?.state),
      provider: AGENT_ID,
      updatedAt: Date.now(),
    });
  }

  private status(taskId: string, status: ReturnType<typeof statusOf>): void {
    const known = this.tasks.get(taskId);
    if (known) {
      this.tasks.set(taskId, { ...known, status, updatedAt: Date.now() });
    }
    this.sink.publish({ type: "event", event: { type: "status", taskId, status } });
  }

  private append(taskId: string, item: ConversationItem): void {
    this.sink.publish({ type: "event", event: { type: "item.append", taskId, item } });
  }

  private say(taskId: string, text: string): void {
    this.append(taskId, { kind: "system", id: crypto.randomUUID(), text });
  }

  private setPhase(to: ConnectionPhase): void {
    if (this.connection.transition(to)) {
      this.sink.publish({ type: "connection", state: to });
    }
  }
}

/** A task's title: the first line of the message that started it. */
function titleOf(message: Message | undefined): string {
  return textOf(message).split("\n")[0]?.slice(0, TASK_TITLE_MAX_CHARS) ?? "";
}

/** Reach a worker's A2A endpoint as a RuntimeClient. Every request stays on the configured origin. */
export async function createAgentClient(options: AgentClientOptions): Promise<AgentClient> {
  const fetchImpl = pinnedFetch(options.url, options.token, options.fetchImpl);
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  const client = await factory.createFromUrl(options.url);
  const card = await client.getAgentCard();

  return new AgentRuntimeClient(client, options.name ?? card.name);
}

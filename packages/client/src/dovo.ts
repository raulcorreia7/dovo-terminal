// Real Dovo Runtime client: HTTP against apps/api, composing the /ws/sync
// channel (dovo-sync.ts), the view projector (dovo-view.ts), and the pure
// wire mapping (dovo-map.ts). Auth: Authorization: Bearer <token> on every
// request (only /health and /api/pair/* are exempt). Reads: GET /api/snapshot.
// Writes: POST /api/tasks/*, POST /api/approvals, PATCH /api/workspace
// (X-Dovo-Mutation-Id for recovery). Realtime via POST /api/sync/ticket
// ?format=5&history=paged -> ws /ws/sync; format 5 activates view
// subscriptions ("watch") so focused-task activity flows.
import { randomUUID } from "node:crypto";
import { DovoError } from "@dovo-terminal/protocol/errors.ts";
import { guard } from "@dovo-terminal/protocol/guard.ts";
import { lifecycleAction } from "@dovo-terminal/protocol/http.ts";
import type {
  ArchiveStore,
  DeviceDirectory,
  PortDirectory,
  RuntimeClient,
} from "@dovo-terminal/protocol/runtime-client.ts";
import type { SyncListener, TaskEvent, Unsubscribe } from "@dovo-terminal/protocol/sync.ts";
import { SyncSink } from "@dovo-terminal/protocol/sync-sink.ts";
import { UpstreamError } from "@dovo-terminal/protocol/upstream-error.ts";
import type {
  AgentProvider,
  CreateTaskInput,
  ModelOption,
  Project,
  TaskHistory,
  TaskSummary,
} from "@dovo-terminal/protocol/workspace.ts";
import { DeviceDesk } from "./dovo-devices.ts";
import {
  APPROVAL_PREFIX,
  answerEcho,
  approvalChoice,
  firstQuestionFieldId,
  QUESTION_PREFIX,
  taskDraft,
  toProviders,
} from "./dovo-map.ts";
import { SnapshotReader } from "./dovo-read.ts";
import { SyncChannel } from "./dovo-sync.ts";
import { ViewProjector } from "./dovo-view.ts";
import {
  type AnswerBody,
  type ApprovalBody,
  type CancelTaskBody,
  type CreateTaskBody,
  type LifecycleBody,
  type MessageBody,
  MutationOutcomeSchema,
  type WireSnapshot,
} from "./dovo-wire.ts";
import { scanPorts } from "./ports.ts";

const PROBLEM_DETAIL_CHARS = 300; // upstream error body kept in DovoError

/** Talks to a real Dovo Studio runtime (apps/api); used by the local server. */
/** Where a Dovo runtime lives and how to authenticate to it. */
export interface RuntimeConfig {
  url: string;
  /** The runtime runs on this machine, so its processes can be inspected here. */
  local?: boolean | undefined;
  /** absent means "discover one" (env, connection file, owner-token file) */
  token?: string | undefined;
}

export function createDovoClient(config: RuntimeConfig): RuntimeClient {
  return new DovoRuntime(config);
}

class DovoRuntime implements RuntimeClient {
  private sink = new SyncSink();

  // latest known task state: the HTTP side and the view projector share one map
  private tasks = new Map<string, TaskSummary>();
  private readonly projector: ViewProjector;
  private readonly channel: SyncChannel;

  private readonly reader: SnapshotReader;
  readonly devices: DeviceDirectory;
  readonly archive: ArchiveStore = { list: () => this.reader.archivedList() };
  /**
   * The Dovo runtime has no port data of its own. When it runs on this machine we
   * can see its processes; when it runs elsewhere that machine's own `dovo serve`
   * answers. This client never guesses from here.
   */
  readonly ports: PortDirectory = {
    list: async () => (this.config.local ? scanPorts(await this.listProjects()) : []),
  };
  private readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    if (!config.token) {
      throw new DovoError(
        `no device/owner token for ${config.url}; run: dovo token <token> (owner token: ~/.dovo/owner-token or runtime-connection.json)`,
      );
    }
    this.config = config;
    this.projector = new ViewProjector(this.sink, this.tasks);
    this.reader = new SnapshotReader(
      (path, init) => this.request(path, init),
      this.tasks,
      this.projector,
    );
    this.devices = new DeviceDesk(
      (path, init) => this.request(path, init),
      (query) => this.reader.snapshot(query),
    );
    this.channel = new SyncChannel({
      url: () => this.config.url,
      request: (path, init) => this.request(path, init),
      sink: this.sink,
      projector: this.projector,
    });
  }

  /** All upstream JSON lands here; callers must validate with a dovo-wire schema. */
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(this.config.url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    }).catch((error: unknown) => {
      throw new DovoError(`runtime unreachable at ${this.config.url}`, { cause: error });
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new DovoError(
        `HTTP ${response.status} ${path}: ${body.slice(0, PROBLEM_DETAIL_CHARS)}`,
        new UpstreamError(body, response.status),
      );
    }
    return await response.json();
  }

  private async post(path: string, body: object): Promise<void> {
    await this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  private snapshot(query: string): Promise<WireSnapshot> {
    return this.reader.snapshot(query);
  }

  listProjects(): Promise<Project[]> {
    return this.reader.projects();
  }

  listTasks(): Promise<TaskSummary[]> {
    return this.reader.taskList();
  }

  listProviders(): Promise<AgentProvider[]> {
    return this.reader.providers();
  }

  listModels(providerId: string): Promise<ModelOption[]> {
    return this.reader.models(providerId);
  }

  getTaskHistory(taskId: string): Promise<TaskHistory> {
    return this.reader.history(taskId);
  }

  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const profiles: AgentProvider[] = await this.snapshot("?scope=overview")
      .then(toProviders)
      .catch(() => []);
    const create = taskDraft(input, profiles, taskId, now);
    // A 200 here can still mean "rejected": the store validates the create
    // after schema decode and reports the verdict in `outcome`, never a status.
    const body = JSON.stringify({
      collection: "tasks",
      id: taskId,
      changes: {},
      create,
    } satisfies CreateTaskBody);
    const reply = await this.request("/api/workspace", {
      method: "PATCH",
      headers: { "X-Dovo-Mutation-Id": randomUUID() },
      body,
    });
    const patch = guard(MutationOutcomeSchema, reply);
    if (patch.outcome && !["applied", "reconciled"].includes(patch.outcome)) {
      throw new DovoError(`task create rejected: ${patch.reason ?? patch.outcome}`);
    }
    await this.sendMessage(taskId, input.prompt);
    const summary: TaskSummary = {
      id: taskId,
      projectId: input.projectId,
      title: create.title ?? "",
      status: "running",
      provider: input.providerId,
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, summary);
    return summary;
  }

  async sendMessage(taskId: string, text: string): Promise<void> {
    // Minimum valid body: id + client-generated messageId + non-empty text.
    // No turnSettings: it is a strictStruct whose provider only accepts
    // harness literals, and the run already binds to the task's agentId/harness.
    const body: MessageBody = { id: taskId, messageId: randomUUID(), text };
    await this.post("/api/tasks/message", body);
  }

  async stopTask(taskId: string): Promise<void> {
    const runId = this.tasks.get(taskId)?.activeRunId;
    if (!runId) {
      throw new DovoError("task has no active run to stop");
    }
    const body: CancelTaskBody = { id: taskId, runId };
    await this.post("/api/tasks/cancel", body);
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "idle";
      task.activeRunId = undefined;
    }
    this.emit({ type: "status", taskId, status: "idle" });
  }

  setTaskArchived(taskId: string, archived: boolean): Promise<void> {
    return this.leaveList(taskId, lifecycleAction(archived));
  }

  deleteTask(taskId: string): Promise<void> {
    return this.leaveList(taskId, "delete");
  }

  /** Archive and delete both remove the task from the list this client serves. */
  private async leaveList(taskId: string, action: LifecycleBody["action"]): Promise<void> {
    const body: LifecycleBody = { id: taskId, action };
    await this.post("/api/tasks/lifecycle", body);
    this.tasks.delete(taskId);
  }

  async answerItem(taskId: string, itemId: string, answer: string): Promise<void> {
    if (itemId.startsWith(APPROVAL_PREFIX)) {
      const { allow, decision } = approvalChoice(answer);
      const body: ApprovalBody = {
        id: itemId.slice(APPROVAL_PREFIX.length),
        allow,
        decision,
      };
      await this.post("/api/approvals", body);
    } else if (itemId.startsWith(QUESTION_PREFIX)) {
      const wireId = itemId.slice(QUESTION_PREFIX.length);
      const questionId =
        this.questionFieldIds.get(wireId) ??
        firstQuestionFieldId(await this.snapshot("?scope=overview"), wireId) ??
        this.registerQuestion(wireId);
      const body: AnswerBody = { id: wireId, answers: { [questionId]: [answer] } };
      await this.post("/api/tasks/answer", body);
    } else {
      throw new DovoError(`unknown item ${itemId}`);
    }
    this.projector.markResolved(taskId);
    this.emit({ type: "item.update", taskId, item: answerEcho(itemId, answer) });
    this.emit({ type: "status", taskId, status: "running" });
  }

  private questionFieldIds = new Map<string, string>();

  /** The overview missed it; it is gone. Report rather than retry forever. */
  private registerQuestion(wireId: string): never {
    throw new DovoError(`question ${wireId} is no longer pending`);
  }

  subscribe(listener: SyncListener): Unsubscribe {
    return this.sink.subscribe(listener);
  }

  connect(): void {
    this.channel.connect();
  }

  close(): void {
    this.channel.close();
    this.reader.clear();
    this.sink.clear();
  }

  focusTask(taskId: string | null): void {
    this.projector.setFocus(taskId);
    this.channel.watchCurrent();
  }

  private emit(event: TaskEvent): void {
    this.sink.publish({ type: "event", event });
  }
}

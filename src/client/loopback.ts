// RuntimeClient over the loopback protocol (protocol/http.ts): JSON REST +
// /ws/sync. Works with any server that implements the protocol - the bundled
// server/, or a stand-in in tests. Reconnects with capped backoff and
// reports reachability downward. The TUI's only runtime implementation.
import type { RuntimeClient } from "dovo-terminal/client/runtime-client.ts";
import { ConnectionStateMachine } from "dovo-terminal/protocol/connection-state.ts";
import { DovoError } from "dovo-terminal/protocol/errors.ts";
import { guard } from "dovo-terminal/protocol/guard.ts";
import { ENDPOINTS, lifecycleAction, syncUrl } from "dovo-terminal/protocol/http.ts";
import {
  type ConnectionPhase,
  SyncFrameSchema,
  type SyncListener,
  type Unsubscribe,
} from "dovo-terminal/protocol/sync.ts";
import { SyncSink } from "dovo-terminal/protocol/sync-sink.ts";
import { UpstreamError } from "dovo-terminal/protocol/upstream-error.ts";
import {
  type AgentProvider,
  AgentProviderSchema,
  type CreateTaskInput,
  CreateTaskInputSchema,
  type Project,
  ProjectSchema,
  type TaskHistory,
  TaskHistorySchema,
  type TaskSummary,
  TaskSummarySchema,
} from "dovo-terminal/protocol/workspace.ts";

// Response shapes the loopback protocol returns as JSON arrays.
const ProjectListSchema = ProjectSchema.array();
const TaskSummaryListSchema = TaskSummarySchema.array();
const AgentProviderListSchema = AgentProviderSchema.array();

const TRAILING_SLASHES = /\/+$/u;

/** Backoff bounds for the /ws/sync reconnect loop. */
export interface ReconnectPolicy {
  baseMs?: number;
  maxMs?: number;
}

const DEFAULT_RECONNECT = { baseMs: 250, maxMs: 2000 } as const;
const NO_CONTENT = 204;
const PROBLEM_DETAIL_CHARS = 200;

function jsonBody(body: unknown): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export class LoopbackRuntimeClient implements RuntimeClient {
  private httpUrl: string;
  private reconnect: { baseMs: number; maxMs: number };
  private retryDelay: number;
  private sink = new SyncSink();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connection = new ConnectionStateMachine();

  constructor(httpUrl: string, reconnect: ReconnectPolicy = {}) {
    this.httpUrl = httpUrl.replace(TRAILING_SLASHES, "");
    this.reconnect = { ...DEFAULT_RECONNECT, ...reconnect };
    this.retryDelay = this.reconnect.baseMs;
  }

  subscribe(listener: SyncListener): Unsubscribe {
    return this.sink.subscribe(listener);
  }

  connect(): void {
    this.openSocket();
  }

  close(): void {
    this.publishConnection("offline");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
    this.socket = null;
    this.sink.clear();
  }

  focusTask(taskId: string | null): void {
    // Fire-and-forget: a dropped focus request only delays stream retargeting.
    void this.put(ENDPOINTS.view, { taskId }).catch(() => undefined);
  }

  async listProjects(): Promise<Project[]> {
    const data = await this.get(ENDPOINTS.projects);
    return guard(ProjectListSchema, data);
  }

  async listTasks(): Promise<TaskSummary[]> {
    const data = await this.get(ENDPOINTS.tasks);
    return guard(TaskSummaryListSchema, data);
  }

  async listProviders(): Promise<AgentProvider[]> {
    const data = await this.get(ENDPOINTS.providers);
    return guard(AgentProviderListSchema, data);
  }

  async getTaskHistory(taskId: string): Promise<TaskHistory> {
    const path = `${ENDPOINTS.taskHistory}?taskId=${encodeURIComponent(taskId)}`;
    const data = await this.get(path);
    return guard(TaskHistorySchema, data);
  }

  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const body = guard(CreateTaskInputSchema, input);
    const data = await this.post(ENDPOINTS.createTask, body);
    return guard(TaskSummarySchema, data);
  }

  async sendMessage(taskId: string, text: string): Promise<void> {
    await this.post(ENDPOINTS.sendMessage, { taskId, text });
  }

  async stopTask(taskId: string): Promise<void> {
    await this.post(ENDPOINTS.stopTask, { taskId });
  }

  async setTaskArchived(taskId: string, archived: boolean): Promise<void> {
    await this.post(ENDPOINTS.lifecycle, { taskId, action: lifecycleAction(archived) });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.post(ENDPOINTS.lifecycle, { taskId, action: "delete" });
  }

  async answerItem(taskId: string, itemId: string, answer: string): Promise<void> {
    await this.post(ENDPOINTS.answer, { taskId, itemId, answer });
  }

  private get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", ...jsonBody(body) });
  }

  private put(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "PUT", ...jsonBody(body) });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.httpUrl + path, init);
    } catch (cause) {
      throw new DovoError(`runtime server at ${this.httpUrl} is unreachable`, { cause });
    }
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (response.status === NO_CONTENT) {
      return undefined;
    }
    return response.json();
  }

  private openSocket(): void {
    if (this.connection.phase === "offline") {
      return; // close() is terminal
    }
    this.publishConnection("connecting");
    const socket = new WebSocket(syncUrl(this.httpUrl));
    this.socket = socket;
    socket.onopen = () => {
      this.retryDelay = this.reconnect.baseMs;
      this.publishConnection("online");
    };
    socket.onmessage = (message: MessageEvent) => {
      try {
        const decoded = JSON.parse(String(message.data));
        const frame = guard(SyncFrameSchema, decoded);
        this.sink.publish(frame);
      } catch {
        // an unknown frame must never take the UI down
      }
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.connection.phase === "offline") {
        return; // close() is terminal; it already announced offline
      }
      this.publishConnection("reconnecting");
      this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
  }

  /** Sole writer of connection state: an illegal transition is never emitted. */
  private publishConnection(to: ConnectionPhase): void {
    if (!this.connection.transition(to)) {
      return;
    }
    this.sink.publish({ type: "connection", state: to });
  }

  private scheduleReconnect(): void {
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, this.reconnect.maxMs);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }
}

async function errorFromResponse(response: Response): Promise<DovoError> {
  const detail = await response.text().catch(() => "");
  return new DovoError(
    `runtime server: ${response.status} ${detail.slice(0, PROBLEM_DETAIL_CHARS)}`,
    new UpstreamError(detail, response.status),
  );
}

/** Connects to a local runtime server; the TUI's only entry point. */
export function createRuntimeClient(connection: {
  url: string;
  reconnect?: ReconnectPolicy;
}): RuntimeClient {
  return new LoopbackRuntimeClient(connection.url, connection.reconnect);
}

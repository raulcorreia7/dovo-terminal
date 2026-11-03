// RuntimeClient over the loopback protocol (#protocol/http.ts): JSON REST +
// /ws/sync. Works with any server that implements the protocol - the bundled
// one (#server/), or a stand-in in tests. Reconnects with capped backoff and
// reports reachability downward. The TUI's only runtime implementation.
import { type RuntimeClient } from "#client/runtime-client.ts";
import { DovoError, UpstreamError } from "#protocol/errors.ts";
import { ENDPOINTS, syncUrl } from "#protocol/http.ts";
import { SyncFrameSchema, SyncSink, type SyncListener, type Unsubscribe } from "#protocol/sync.ts";
import {
  AgentProviderSchema,
  CreateTaskInputSchema,
  ProjectSchema,
  TaskHistorySchema,
  TaskSummarySchema,
  type AgentProvider,
  type CreateTaskInput,
  type Project,
  type TaskHistory,
  type TaskSummary,
} from "#protocol/workspace.ts";

/** Backoff bounds for the /ws/sync reconnect loop. */
export interface ReconnectPolicy {
  baseMs?: number;
  maxMs?: number;
}

const DEFAULT_RECONNECT = { baseMs: 250, maxMs: 2_000 } as const;
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
  private closed = false;

  constructor(httpUrl: string, reconnect: ReconnectPolicy = {}) {
    this.httpUrl = httpUrl.replace(/\/+$/, "");
    this.reconnect = { ...DEFAULT_RECONNECT, ...reconnect };
    this.retryDelay = this.reconnect.baseMs;
  }

  subscribe(listener: SyncListener): Unsubscribe {
    return this.sink.subscribe(listener);
  }

  connect(): void {
    this.openSocket();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.sink.clear();
  }

  focusTask(taskId: string | null): void {
    // Fire-and-forget: a dropped focus request only delays stream retargeting.
    void this.put(ENDPOINTS.view, { taskId }).catch(() => undefined);
  }

  listProjects(): Promise<Project[]> {
    return this.get(ENDPOINTS.projects).then((data) => ProjectSchema.array().parse(data));
  }

  listTasks(): Promise<TaskSummary[]> {
    return this.get(ENDPOINTS.tasks).then((data) => TaskSummarySchema.array().parse(data));
  }

  listProviders(): Promise<AgentProvider[]> {
    return this.get(ENDPOINTS.providers).then((data) => AgentProviderSchema.array().parse(data));
  }

  getTaskHistory(taskId: string): Promise<TaskHistory> {
    const path = `${ENDPOINTS.taskHistory}?taskId=${encodeURIComponent(taskId)}`;
    return this.get(path).then((data) => TaskHistorySchema.parse(data));
  }

  createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const body = CreateTaskInputSchema.parse(input);
    return this.post(ENDPOINTS.createTask, body).then((data) => TaskSummarySchema.parse(data));
  }

  async sendMessage(taskId: string, text: string): Promise<void> {
    await this.post(ENDPOINTS.sendMessage, { taskId, text });
  }

  async stopTask(taskId: string): Promise<void> {
    await this.post(ENDPOINTS.stopTask, { taskId });
  }

  async setTaskArchived(taskId: string, archived: boolean): Promise<void> {
    await this.post(ENDPOINTS.lifecycle, { taskId, action: archived ? "archive" : "restore" });
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
      throw new DovoError(`runtime server at ${this.httpUrl} is unreachable`, cause);
    }
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === NO_CONTENT) return undefined;
    return response.json();
  }

  private openSocket(): void {
    if (this.closed) return;
    const socket = new WebSocket(syncUrl(this.httpUrl));
    this.socket = socket;
    socket.onopen = () => {
      this.retryDelay = this.reconnect.baseMs;
      this.sink.publish({ type: "connection", connected: true });
    };
    socket.onmessage = (message: MessageEvent) => {
      const frame = parseFrame(String(message.data));
      if (frame) this.sink.publish(frame);
    };
    socket.onclose = () => {
      this.socket = null;
      this.sink.publish({ type: "connection", connected: false });
      if (!this.closed) this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(): void {
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, this.reconnect.maxMs);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }
}

function parseFrame(text: string) {
  try {
    return SyncFrameSchema.parse(JSON.parse(text));
  } catch {
    return undefined; // an unknown frame must never take the UI down
  }
}

async function errorFromResponse(response: Response): Promise<DovoError> {
  const detail = await response.text().catch(() => "");
  return new DovoError(`runtime server: ${response.status} ${detail.slice(0, PROBLEM_DETAIL_CHARS)}`, new UpstreamError(detail, response.status));
}

/** Connects to a local runtime server; the TUI's only entry point. */
export function createRuntimeClient(connection: {
  url: string;
  reconnect?: ReconnectPolicy;
}): RuntimeClient {
  return new LoopbackRuntimeClient(connection.url, connection.reconnect);
}

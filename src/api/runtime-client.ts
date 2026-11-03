// Real Dovo Runtime client. Wire contract verified against dovocode/dovo-studio
// @ a3297a9 (packages/runtime/src/http/routes.ts, packages/protocol/src/runtime/connection/sync.ts).
// Auth: Authorization: Bearer <owner-or-device-token> on every request (only /health and
// /api/pair/* are exempt). Reads: GET /api/snapshot. Writes: POST /api/tasks/*,
// POST /api/approvals, PATCH /api/workspace (X-Dovo-Mutation-Id for recovery).
// Realtime: POST /api/sync/ticket?format=5&history=paged -> ws /ws/sync, then
// {"type":"resume"} within 10 s; format 5 activates view subscriptions ("watch")
// so focused-task activity and streaming updates flow.
import { randomUUID } from "node:crypto";
import { DovoError, type CreateTaskInput, type DovoClient } from "./client.ts";
import type { RuntimeConfig } from "../config.ts";
import type {
  AgentProvider,
  ConversationItem,
  Project,
  TaskEvent,
  TaskHistory,
  TaskStatus,
  TaskSummary,
} from "./types.ts";

/* ------------------------------------------------------------------ wire ---- */

interface WireSnapshot {
  runtimeInstanceId?: string;
  approvals?: WireApproval[];
  questions?: WireQuestion[];
  workspace?: {
    repositories?: { id: string; name: string; path: string }[];
    agents?: { id: string; name: string; provider: string }[];
    tasks?: WireTask[];
  };
}

interface WireTask {
  id: string;
  title?: string;
  repositoryId?: string;
  agentId?: string;
  harness?: { provider?: string };
  status?: string;
  activeRunId?: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  messages?: WireMessage[];
}

interface WireMessage {
  id: string;
  role: string;
  text: string;
  createdAt?: string;
}

interface WireApproval {
  id: string;
  taskId: string;
  title: string;
  detail?: string;
  scopes?: { session?: boolean; always?: boolean };
}

interface WireQuestion {
  id: string;
  taskId: string;
  prompt: {
    title?: string;
    questions: {
      id: string;
      question: string;
      header?: string;
      options?: { value: string; label: string }[];
      custom?: boolean;
    }[];
  };
}

interface ActivityEvent {
  id: string;
  time?: string;
  kind?: string;
  scope?: string;
  summary?: string;
  payload?: string;
}

interface ActivityDelta {
  changes?: {
    fields?: ActivityEvent;
    payload?: string | { length: number; offset: number; remove: number; insert: string };
  }[];
}

/* ------------------------------------------------------------- status map --- */

const statusMap: Record<string, TaskStatus> = {
  draft: "idle",
  running: "running",
  review: "idle",
  done: "idle",
  failed: "error",
  cancelled: "idle",
};

function mapStatus(task: WireTask, pending: Set<string>): TaskStatus {
  if (task.id && pending.has(task.id)) return "waiting";
  return statusMap[task.status ?? ""] ?? "unknown";
}

/* ------------------------------------------------------------- translation -- */

function toProjects(snapshot: WireSnapshot): Project[] {
  return (snapshot.workspace?.repositories ?? []).map((repo) => ({
    id: repo.id,
    name: repo.name,
    path: repo.path,
  }));
}

function toProviders(snapshot: WireSnapshot): AgentProvider[] {
  return (snapshot.workspace?.agents ?? []).map((agent) => ({
    id: agent.id,
    label: `${agent.name} (${agent.provider})`,
  }));
}

function toTaskSummary(task: WireTask, pending: Set<string>): TaskSummary {
  const timestamp = Date.parse(task.updatedAt ?? task.createdAt ?? "") || Date.now();
  return {
    id: task.id,
    projectId: task.repositoryId ?? "",
    title: task.title ?? "",
    status: mapStatus(task, pending),
    provider: task.harness?.provider ?? task.agentId ?? "",
    updatedAt: timestamp,
    activeRunId: task.activeRunId,
  };
}

function pendingTaskIds(snapshot: WireSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const approval of snapshot.approvals ?? []) ids.add(approval.taskId);
  for (const question of snapshot.questions ?? []) ids.add(question.taskId);
  return ids;
}

function approvalItem(approval: WireApproval): ConversationItem {
  const options = [{ id: "approve", label: "Yes, allow once" }];
  if (approval.scopes?.session) options.push({ id: "session", label: "Allow for session" });
  if (approval.scopes?.always) options.push({ id: "always", label: "Always allow" });
  options.push({ id: "deny", label: "No" });
  return {
    kind: "approval",
    id: `approval:${approval.id}`,
    title: approval.title,
    detail: approval.detail ?? "",
    options,
    answered: null,
  };
}

function questionItem(question: WireQuestion): ConversationItem {
  const first = question.prompt.questions[0];
  return {
    kind: "approval",
    id: `question:${question.id}`,
    title: question.prompt.title ?? first?.question ?? "Question",
    detail: first?.question ?? "",
    options: (first?.options ?? []).map((option) => ({ id: option.value, label: option.label })),
    answered: null,
  };
}

/* ------------------------------------------------------------------ client -- */

export function createRuntimeClient(config: RuntimeConfig): DovoClient {
  return new RuntimeClient(config);
}

class RuntimeClient implements DovoClient {
  onEvent: ((event: TaskEvent) => void) | null = null;
  onConnection: ((connected: boolean) => void) | null = null;
  onSync: (() => void) | null = null;

  private socket: WebSocket | null = null;
  private closed = false;
  private retryMs = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private epoch: string | null = null;
  private sequence = 0;
  private focused: string | null = null;

  // latest known state, used for control ops and delta bookkeeping
  private tasks = new Map<string, TaskSummary>();
  private messageText = new Map<string, { role: string; text: string }>();
  private pendingIds = new Set<string>();
  private emittedApprovals = new Set<string>();
  private emittedTools = new Set<string>();
  private activityEvents = new Map<string, ActivityEvent>();

  // snapshot fetch dedupe: only for IDENTICAL queries (the three list* calls
  // of one refresh); a threads-scope fetch must never receive an overview.
  private readonly inflight = new Map<string, Promise<WireSnapshot>>();

  private readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    if (!config.token) {
      throw new DovoError(
        `no device/owner token for ${config.url}; run: dovo token <token> (owner token: ~/.dovo/owner-token or runtime-connection.json)`,
      );
    }
    this.config = config;
  }

  /* ------------------------------------------------------------------- http */

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.config.url + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    }).catch((error: unknown) => {
      throw new DovoError(`runtime unreachable at ${this.config.url}`, error);
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new DovoError(`HTTP ${response.status} ${path}: ${body.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  private snapshot(query: string): Promise<WireSnapshot> {
    let pending = this.inflight.get(query);
    if (!pending) {
      pending = this.request<WireSnapshot>(`/api/snapshot${query}`).finally(() => {
        this.inflight.delete(query);
      });
      this.inflight.set(query, pending);
    }
    return pending;
  }

  async listProjects(): Promise<Project[]> {
    return toProjects(await this.snapshot("?scope=overview"));
  }

  async listTasks(): Promise<TaskSummary[]> {
    const snapshot = await this.snapshot("?scope=overview");
    const pending = pendingTaskIds(snapshot);
    this.pendingIds = pending;
    // archivedAt hides a thread from normal lists; the legacy `archived`
    // boolean only means "settled" and must not hide anything (workspace.ts:986).
    const tasks = (snapshot.workspace?.tasks ?? [])
      .filter((task) => !task.archivedAt)
      .map((task) => toTaskSummary(task, pending));
    this.tasks = new Map(tasks.map((task) => [task.id, task]));
    return tasks;
  }

  async listProviders(): Promise<AgentProvider[]> {
    const snapshot = await this.snapshot("?scope=overview");
    const providers = toProviders(snapshot);
    try {
      const availability = await this.request<{ id: string; available: boolean }[]>(
        "/api/agents/availability",
        { method: "POST", body: "{}" },
      );
      for (const entry of availability) {
        if (!entry.available || !entry.id.startsWith("harness:")) continue;
        const id = entry.id.slice("harness:".length);
        if (!providers.some((provider) => provider.id === id)) {
          providers.push({ id, label: id });
        }
      }
    } catch {
      // availability probe is optional; profiles remain usable
    }
    return providers;
  }

  async getTaskHistory(taskId: string): Promise<TaskHistory> {
    const snapshot = await this.snapshot(`?scope=threads&task=${encodeURIComponent(taskId)}`);
    const task = (snapshot.workspace?.tasks ?? []).find((entry) => entry.id === taskId);
    const items: ConversationItem[] = (task?.messages ?? []).map((message) =>
      message.role === "user"
        ? { kind: "user" as const, id: message.id, text: message.text }
        : { kind: "assistant" as const, id: message.id, text: message.text, done: true },
    );
    for (const approval of snapshot.approvals ?? []) {
      if (approval.taskId === taskId) items.push(approvalItem(approval));
    }
    for (const question of snapshot.questions ?? []) {
      if (question.taskId === taskId) items.push(questionItem(question));
    }
    items.push(...(await this.toolItems(taskId)));
    const pending = pendingTaskIds(snapshot);
    const summary = task ? toTaskSummary(task, pending) : null;
    if (summary) this.tasks.set(taskId, summary);
    return {
      items,
      status: summary?.status ?? "unknown",
      activeRunId: summary?.activeRunId,
    };
  }

  /** Tool history comes from the activity log; failures degrade to none. */
  private async toolItems(taskId: string): Promise<ConversationItem[]> {
    try {
      // /api/activity returns {events:[…]} (routes.ts:1134 → activitySchema),
      // not a bare array; includeDetails stays false for the compact payloads.
      const page = await this.request<{ events?: ActivityEvent[] }>("/api/activity", {
        method: "POST",
        body: JSON.stringify({ scope: taskId, query: "tool", kind: "tool", offset: 0 }),
      });
      return (page.events ?? [])
        .filter((event) => event.kind === "tool")
        .map((event) => this.toToolItem(event));
    } catch {
      return [];
    }
  }

  private toToolItem(event: ActivityEvent): ConversationItem {
    let state: "running" | "ok" | "error" = "running";
    let detail = "";
    try {
      // Compacted tool payload (activity.ts): {status, presentation:{kind,input,detail,diff}}.
      const payload = JSON.parse(String(event.payload ?? "{}")) as {
        status?: string;
        text?: string;
        presentation?: { input?: unknown; detail?: unknown; diff?: unknown };
      };
      if (payload.status && /fail|error|denied/i.test(payload.status)) state = "error";
      else if (payload.status && /complete|success|ok|done/i.test(payload.status)) state = "ok";
      const line = payload.presentation?.input ?? payload.presentation?.detail ?? payload.text;
      if (typeof line === "string") detail = line.split("\n")[0]?.slice(0, 120) ?? "";
    } catch {
      /* payload not JSON; keep defaults */
    }
    return {
      kind: "tool",
      id: `tool:${event.id}`,
      name: event.summary ?? "tool",
      detail,
      state,
    };
  }

  /* ----------------------------------------------------------------- writes */

  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const title = input.prompt.split("\n")[0]!.slice(0, 72);
    const create: Record<string, unknown> = {
      id: taskId,
      repositoryId: input.projectId,
      title,
      agentId: "",
      harness: {
        provider: input.providerId.replace(/^harness:/, ""),
        model: "",
        reasoning: "",
        serviceTier: "",
        instructions: "",
        permission: "ask",
        endpoint: "",
      },
      execution: "main",
      status: "draft",
      createdAt: now,
      messages: [],
      files: [],
      draft: "",
      example: false,
    };
    const profiles = await this.snapshot("?scope=overview")
      .then(toProviders)
      .catch(() => [] as AgentProvider[]);
    if (profiles.some((profile) => profile.id === input.providerId)) {
      create.agentId = input.providerId;
      delete create.harness;
    }
    // A 200 here can still mean "rejected": the store validates the create
    // after schema decode and reports the verdict in `outcome`, never a status.
    const patch = await this.request<{ outcome?: string; reason?: string }>("/api/workspace", {
      method: "PATCH",
      headers: { "X-Dovo-Mutation-Id": randomUUID() },
      body: JSON.stringify({ collection: "tasks", id: taskId, changes: {}, create }),
    });
    if (patch.outcome && !["applied", "reconciled"].includes(patch.outcome)) {
      throw new DovoError(`task create rejected: ${patch.reason ?? patch.outcome}`);
    }
    await this.sendMessage(taskId, input.prompt);
    const summary: TaskSummary = {
      id: taskId,
      projectId: input.projectId,
      title,
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
    await this.request("/api/tasks/message", {
      method: "POST",
      body: JSON.stringify({ id: taskId, messageId: randomUUID(), text }),
    });
  }

  async stopTask(taskId: string): Promise<void> {
    const runId = this.tasks.get(taskId)?.activeRunId;
    if (!runId) throw new DovoError("task has no active run to stop");
    await this.request("/api/tasks/cancel", {
      method: "POST",
      body: JSON.stringify({ id: taskId, runId }),
    });
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "idle";
      task.activeRunId = undefined;
    }
    this.emit({ type: "status", taskId, status: "idle" });
  }

  async setTaskArchived(taskId: string, archived: boolean): Promise<void> {
    await this.request("/api/tasks/lifecycle", {
      method: "POST",
      body: JSON.stringify({ id: taskId, action: archived ? "archive" : "restore" }),
    });
    this.tasks.delete(taskId);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.request("/api/tasks/lifecycle", {
      method: "POST",
      body: JSON.stringify({ id: taskId, action: "delete" }),
    });
    this.tasks.delete(taskId);
  }

  async answerItem(taskId: string, itemId: string, answer: string): Promise<void> {
    if (itemId.startsWith("approval:")) {
      const decision = /no|deny/i.test(answer) ? "deny" : answer;
      const allow = decision !== "deny";
      await this.request("/api/approvals", {
        method: "POST",
        body: JSON.stringify({
          id: itemId.slice("approval:".length),
          allow,
          decision: ["approve", "session", "always"].includes(decision) ? decision : "approve",
        }),
      });
    } else if (itemId.startsWith("question:")) {
      const wireId = itemId.slice("question:".length);
      const questionId = this.questionFieldIds.get(wireId) ?? (await this.firstQuestionId(wireId));
      await this.request("/api/tasks/answer", {
        method: "POST",
        body: JSON.stringify({ id: wireId, answers: { [questionId]: [answer] } }),
      });
    } else {
      throw new DovoError(`unknown item ${itemId}`);
    }
    this.pendingIds.delete(taskId);
    this.emit({
      type: "item.update",
      taskId,
      item: {
        kind: "approval",
        id: itemId,
        title: "",
        detail: "",
        options: [],
        answered: answer,
      },
    });
    this.emit({ type: "status", taskId, status: "running" });
  }

  private questionFieldIds = new Map<string, string>();

  private async firstQuestionId(wireId: string): Promise<string> {
    const snapshot = await this.snapshot("?scope=overview");
    for (const question of snapshot.questions ?? []) {
      if (question.id === wireId) {
        const id = question.prompt.questions[0]?.id ?? "";
        this.questionFieldIds.set(wireId, id);
        return id;
      }
    }
    throw new DovoError(`question ${wireId} is no longer pending`);
  }

  /* ---------------------------------------------------------------- realtime */

  connect(): void {
    void this.openChannel();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  focusTask(taskId: string | null): void {
    if (this.focused === taskId) return;
    this.focused = taskId;
    this.emittedApprovals.clear();
    this.emittedTools.clear();
    this.messageText.clear();
    this.activityEvents.clear();
    if (this.socket?.readyState === WebSocket.OPEN && taskId) {
      this.socket.send(JSON.stringify({ type: "watch", tasks: [taskId], scopes: [taskId] }));
    }
  }

  private async openChannel(): Promise<void> {
    if (this.closed) return;
    try {
      const { ticket } = await this.request<{ ticket: string }>(
        "/api/sync/ticket?format=5&history=paged",
        { method: "POST", body: "{}" },
      );
      const url = this.config.url.replace(/^http/, "ws") + `/ws/sync?ticket=${encodeURIComponent(ticket)}`;
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.retryMs = 1_000;
        this.onConnection?.(true);
        socket.send(JSON.stringify({ type: "resume" }));
        if (this.focused) {
          socket.send(JSON.stringify({ type: "watch", tasks: [this.focused], scopes: [this.focused] }));
        }
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") this.handleFrame(event.data);
      });
      socket.addEventListener("close", () => this.scheduleReconnect());
      socket.addEventListener("error", () => socket.close());
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.onConnection?.(false);
    this.socket = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.epoch = null;
      void this.openChannel();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
  }

  private handleFrame(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (frame.type) {
      case "snapshot": {
        this.epoch = String(frame.epoch ?? "");
        this.sequence = Number(frame.sequence ?? 0);
        this.applySnapshotBaseline(frame.snapshot as WireSnapshot | undefined);
        break;
      }
      case "selection": {
        this.epoch = String(frame.epoch ?? "");
        this.sequence = Number(frame.sequence ?? 0);
        this.applyDelta(frame.delta as Record<string, unknown>, true);
        break;
      }
      case "delta": {
        const base = Number(frame.base ?? -1);
        if (frame.epoch !== this.epoch) {
          // new view epoch: re-fetch a ticket for a fresh baseline
          this.onConnection?.(false);
          this.socket?.close();
          return;
        }
        if (base !== this.sequence) {
          // cursor gap: ask the server to replay from our position (it rebases
          // with a snapshot frame when the replay window no longer covers us)
          this.sendInput({ type: "resume", epoch: this.epoch, sequence: this.sequence });
          return;
        }
        this.sequence = Number(frame.sequence ?? this.sequence);
        this.applyDelta(frame.delta as Record<string, unknown>, false);
        this.onSync?.();
        break;
      }
      case "activity":
        this.applyActivity(
          String(frame.scope ?? ""),
          (frame.events ?? []) as ActivityEvent[],
        );
        break;
      case "activity-delta":
        this.applyActivityDelta(
          String(frame.scope ?? ""),
          (frame.delta ?? {}) as ActivityDelta,
        );
        break;
      case "heartbeat": {
        const sequence = Number(frame.sequence ?? this.sequence);
        if (frame.epoch === this.epoch && sequence > this.sequence) {
          // missed frames: resume replays from our cursor or rebases us
          this.sendInput({ type: "resume", epoch: this.epoch, sequence: this.sequence });
        } else {
          this.sequence = sequence;
        }
        break;
      }
    }
  }

  private sendInput(input: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(input));
    }
  }

  /** Baseline snapshot: rebuild streaming text state and approvals for view. */
  private applySnapshotBaseline(snapshot: WireSnapshot | undefined): void {
    if (!snapshot?.workspace) return;
    this.messageText.clear();
    for (const task of snapshot.workspace.tasks ?? []) {
      for (const message of task.messages ?? []) {
        this.messageText.set(message.id, { role: message.role, text: message.text ?? "" });
      }
    }
    this.emittedApprovals.clear();
    for (const approval of snapshot.approvals ?? []) {
      this.emittedApprovals.add(approval.id);
    }
    for (const question of snapshot.questions ?? []) {
      this.emittedApprovals.add(`q:${question.id}`);
      if (question.prompt.questions[0]?.id) {
        this.questionFieldIds.set(question.id, question.prompt.questions[0].id);
      }
    }
  }

  private applyDelta(delta: Record<string, unknown>, fullReplace: boolean): void {
    const pendingNow = new Set<string>();
    const state = delta.state as Record<string, unknown> | undefined;
    if (state?.approvals) {
      for (const approval of state.approvals as WireApproval[]) pendingNow.add(approval.taskId);
    }
    const taskChanges = (
      ((delta.workspace as Record<string, unknown> | undefined)?.tasks ?? {}) as Record<
        string,
        unknown
      >
    ).changes as
      | {
          id: string;
          fields?: Record<string, unknown>;
          fieldDelta?: { values?: Record<string, unknown>; removed?: string[] };
          messages?: { changes?: { fields?: WireMessage & { text?: unknown }; text?: unknown }[] };
        }[]
      | undefined;

    for (const change of taskChanges ?? []) {
      const taskId = change.id;
      const values = {
        ...(change.fields ?? {}),
        ...(change.fieldDelta?.values ?? {}),
      };
      const task = this.tasks.get(taskId);
      let status: TaskStatus | null = null;
      if (typeof values.status === "string") status = statusMap[values.status] ?? "unknown";
      if (typeof values.activeRunId === "string" && task) task.activeRunId = values.activeRunId;
      if (fullReplace) status = null; // selection handoffs re-fetch via getTaskHistory

      for (const messageChange of change.messages?.changes ?? []) {
        this.applyMessageChange(taskId, messageChange);
      }

      if (status && task && (this.focused === taskId || fullReplace)) {
        task.status = status;
        this.emit({ type: "status", taskId, status, activeRunId: task.activeRunId });
      }
    }

    if (state?.approvals) {
      for (const approval of state.approvals as WireApproval[]) {
        if (!this.emittedApprovals.has(approval.id)) {
          this.emittedApprovals.add(approval.id);
          this.emit({ type: "item.append", taskId: approval.taskId, item: approvalItem(approval) });
        }
      }
    }
    if (state?.questions) {
      for (const question of state.questions as WireQuestion[]) {
        const key = `q:${question.id}`;
        if (question.prompt.questions[0]?.id) {
          this.questionFieldIds.set(question.id, question.prompt.questions[0].id);
        }
        if (!this.emittedApprovals.has(key)) {
          this.emittedApprovals.add(key);
          this.emit({ type: "item.append", taskId: question.taskId, item: questionItem(question) });
        }
      }
    }
    const hadPending = this.pendingIds;
    if (state?.approvals || state?.questions) {
      this.pendingIds = pendingNow;
      for (const taskId of hadPending) {
        if (!pendingNow.has(taskId)) {
          this.emit({ type: "status", taskId, status: "running", activeRunId: this.tasks.get(taskId)?.activeRunId });
        }
      }
      for (const taskId of pendingNow) {
        this.emit({ type: "status", taskId, status: "waiting" });
      }
    }
  }

  private applyMessageChange(
    taskId: string,
    change: { fields?: WireMessage & { text?: unknown }; text?: unknown },
  ): void {
    const fields = change.fields;
    if (!fields?.id) return;
    const id = fields.id;
    const existing = this.messageText.get(id);
    const role = fields.role ?? existing?.role ?? "assistant";
    let text = existing?.text ?? "";
    if (typeof fields.text === "string") text = fields.text;
    const raw = change.text;
    if (typeof raw === "string") text = raw;
    else if (raw && typeof raw === "object" && "append" in raw && typeof raw.append === "string") {
      text += raw.append;
    }
    this.messageText.set(id, { role, text });
    const item: ConversationItem =
      role === "user"
        ? { kind: "user", id, text }
        : { kind: "assistant", id, text, done: false };
    this.emit({
      type: existing ? "item.update" : "item.append",
      taskId,
      item,
    });
  }

  private applyActivity(scope: string, events: ActivityEvent[]): void {
    if (!scope || scope !== this.focused) return;
    for (const event of events) {
      this.activityEvents.set(event.id, { ...this.activityEvents.get(event.id), ...event });
      this.emitToolEvent(scope, event.id);
    }
  }

  private applyActivityDelta(scope: string, delta: ActivityDelta): void {
    if (!scope || scope !== this.focused) return;
    for (const change of delta.changes ?? []) {
      if (!change.fields?.id) continue;
      const id = change.fields.id;
      const previous = this.activityEvents.get(id) ?? { id };
      const merged: ActivityEvent = { ...previous, ...change.fields };
      const payload = change.payload;
      if (typeof payload === "string") merged.payload = payload;
      else if (payload && typeof payload === "object" && "insert" in payload) {
        const base = previous.payload ?? "";
        const offset = Math.min(Math.max(payload.offset, 0), base.length);
        const next = base.slice(0, offset) + payload.insert + base.slice(offset + payload.remove);
        merged.payload = Number.isFinite(payload.length) ? next.slice(0, payload.length) : next;
      }
      this.activityEvents.set(id, merged);
      this.emitToolEvent(scope, id);
    }
  }

  private emitToolEvent(scope: string, id: string): void {
    const event = this.activityEvents.get(id);
    if (!event || event.kind !== "tool") return;
    const item = this.toToolItem(event);
    const first = !this.emittedTools.has(id);
    this.emittedTools.add(id);
    this.emit({ type: first ? "item.append" : "item.update", taskId: scope, item });
  }

  private emit(event: TaskEvent): void {
    this.onEvent?.(event);
  }
}

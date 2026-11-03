import { randomUUID } from "node:crypto";
import type { RuntimeClient } from "#client/runtime-client.ts";
import { DovoError } from "#protocol/errors.ts";
import { TASK_TITLE_MAX_CHARS } from "#protocol/workspace.ts";
import type { CreateTaskInput } from "#protocol/workspace.ts";
import { SyncSink, type SyncListener, type TaskEvent, type Unsubscribe } from "#protocol/sync.ts";
import type {
  AgentProvider,
  ConversationItem,
  Project,
  TaskHistory,
  TaskSummary,
} from "#protocol/workspace.ts";

const SYNC_HINT_AFTER_CREATE_MS = 50;

// Deterministic fake runtime: streams scripted agent turns with the same event
// discipline as the real client. Serves `dovo serve --demo`, `dovo --demo`,
// and the TUI smoke test - the app runs on it alone, no Dovo required.
// Pacing values are arbitrary; their order is not.
export class DemoClient implements RuntimeClient {
  private sink = new SyncSink();

  private readonly projects: Project[] = [
    { id: "p-alpha", name: "website", path: "/srv/website" },
    { id: "p-beta", name: "infra", path: "/srv/infra" },
  ];
  private readonly providers: AgentProvider[] = [
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude" },
  ];
  private tasks = new Map<string, TaskSummary>();
  private items = new Map<string, ConversationItem[]>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    this.seedTask(
      "t-old",
      "p-alpha",
      "Fix header overflow on mobile",
      "idle",
      "codex",
      Date.now() - 3_600_000,
    );
    this.items.set("t-old", [
      { kind: "user", id: "i1", text: "The nav wraps on narrow screens" },
      { kind: "assistant", id: "i2", text: "Fixed by constraining the flex row.\n\n```css\nnav { flex-wrap: nowrap; }\n```", done: true },
    ]);
  }

  subscribe(listener: SyncListener): Unsubscribe {
    return this.sink.subscribe(listener);
  }

  connect(): void {
    this.publishConnection(true);
  }

  focusTask(_taskId: string | null): void {}

  async close(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.publishConnection(false);
    this.sink.clear();
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects];
  }

  private readonly archived = new Set<string>();

  async listTasks(): Promise<TaskSummary[]> {
    return [...this.tasks.values()]
      .filter((task) => !this.archived.has(task.id))
      .map((task) => ({ ...task }));
  }

  async listProviders(): Promise<AgentProvider[]> {
    return [...this.providers];
  }

  async getTaskHistory(taskId: string): Promise<TaskHistory> {
    const task = this.mustTask(taskId);
    return {
      items: [...(this.items.get(taskId) ?? [])],
      status: task.status,
      activeRunId: task.activeRunId,
    };
  }

  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const id = randomUUID();
    const task = this.seedTask(
      id,
      input.projectId,
      input.prompt.split("\n")[0]!.slice(0, TASK_TITLE_MAX_CHARS),
      "running",
      input.providerId,
      Date.now(),
    );
    task.activeRunId = randomUUID();
    this.append(id, { kind: "user", id: randomUUID(), text: input.prompt });
    this.streamAgentReply(id, input.prompt);
    // the real runtime broadcasts a sync frame shortly after create; mirror it
    this.at(SYNC_HINT_AFTER_CREATE_MS, () => this.sink.publish({ type: "sync" }));
    return { ...task };
  }

  async sendMessage(taskId: string, text: string): Promise<void> {
    const task = this.mustTask(taskId);
    task.status = "running";
    task.activeRunId = randomUUID();
    this.emit({ type: "status", taskId, status: "running", activeRunId: task.activeRunId });
    this.append(taskId, { kind: "user", id: randomUUID(), text });
    this.streamAgentReply(taskId, text);
  }

  async stopTask(taskId: string): Promise<void> {
    const task = this.mustTask(taskId);
    task.status = "idle";
    task.activeRunId = undefined;
    this.emit({ type: "status", taskId, status: "idle" });
    this.append(taskId, { kind: "system", id: randomUUID(), text: "run stopped" });
  }

  async setTaskArchived(taskId: string, archived: boolean): Promise<void> {
    this.mustTask(taskId);
    if (archived) this.archived.add(taskId);
    else this.archived.delete(taskId);
  }

  async deleteTask(taskId: string): Promise<void> {
    this.mustTask(taskId);
    this.tasks.delete(taskId);
    this.archived.delete(taskId);
    this.items.delete(taskId);
  }

  async answerItem(taskId: string, itemId: string, answer: string): Promise<void> {
    const items = this.items.get(taskId) ?? [];
    const item = items.find((entry) => entry.id === itemId);
    if (!item || item.kind !== "approval") return;
    item.answered = answer;
    this.emit({ type: "item.update", taskId, item: { ...item } });
    const task = this.mustTask(taskId);
    task.status = "running";
    this.emit({ type: "status", taskId, status: "running", activeRunId: task.activeRunId });
    this.streamAgentReply(taskId, answer);
  }

  // --- scripted behavior ------------------------------------------------------

  private seedTask(
    id: string,
    projectId: string,
    title: string,
    status: TaskSummary["status"],
    provider: string,
    updatedAt: number,
  ): TaskSummary {
    const task: TaskSummary = { id, projectId, title, status, provider, updatedAt };
    this.tasks.set(id, task);
    this.items.set(id, this.items.get(id) ?? []);
    return task;
  }

  private mustTask(id: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new DovoError(`unknown task ${id}`);
    return task;
  }

  private streamAgentReply(taskId: string, prompt: string): void {
    const toolId = randomUUID();
    const replyId = randomUUID();
    const chunks = [
      "Working on it.\n\n",
      `Here is what I found about **${prompt.slice(0, 40)}**:\n\n`,
      "- inspected the project files\n",
      "- checked recent diffs\n\n",
      "The change is straightforward; I will apply it once you approve.\n",
    ];
    let delay = 300;
    this.at(delay, () =>
      this.append(taskId, {
        kind: "tool",
        id: toolId,
        name: "search",
        detail: "pattern: " + prompt.slice(0, 24),
        state: "running",
      }),
    );
    delay += 700;
    this.at(delay, () => {
      const item: ConversationItem = { kind: "tool", id: toolId, name: "search", detail: "12 matches", state: "ok" };
      this.update(taskId, item);
    });
    delay += 300;
    let partial = "";
    for (const chunk of chunks) {
      delay += 350;
      const text = chunk;
      this.at(delay, () => {
        partial += text;
        const item: ConversationItem = { kind: "assistant", id: replyId, text: partial, done: false };
        if (partial === text) this.append(taskId, item);
        else this.update(taskId, item);
      });
    }
    delay += 400;
    this.at(delay, () => {
      this.update(taskId, { kind: "assistant", id: replyId, text: partial, done: true });
      this.append(taskId, {
        kind: "approval",
        id: randomUUID(),
        title: "Apply change to main?",
        detail: "git apply --index 1-file patch",
        options: [
          { id: "yes", label: "Yes, apply" },
          { id: "no", label: "No, keep planning" },
        ],
        answered: null,
      });
      const task = this.mustTask(taskId);
      task.status = "waiting";
      this.emit({ type: "status", taskId, status: "waiting" });
    });
  }

  private stopped = false;

  private at(ms: number, fn: () => void): void {
    // A scripted turn must not resurrect activity after close(); its timers,
    // subscriptions, and the event loop must all be finished.
    if (this.stopped) return;
    this.timers.push(setTimeout(fn, ms));
  }

  private append(taskId: string, item: ConversationItem): void {
    (this.items.get(taskId) ?? this.items.set(taskId, []).get(taskId)!).push(item);
    this.emit({ type: "item.append", taskId, item });
  }

  private update(taskId: string, item: ConversationItem): void {
    const items = this.items.get(taskId) ?? [];
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) items[index] = item;
    this.emit({ type: "item.update", taskId, item });
  }

  private emit(event: TaskEvent): void {
    this.sink.publish({ type: "event", event });
  }

  private publishConnection(connected: boolean): void {
    // After close() the sink is empty; publishing is harmless either way.
    this.sink.publish({ type: "connection", connected });
  }
}

/** Scripted runtime, no Dovo installation involved. */
export function createDemoClient(): RuntimeClient {
  return new DemoClient();
}

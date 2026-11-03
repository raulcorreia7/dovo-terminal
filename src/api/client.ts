import type { AgentProvider, Project, TaskEvent, TaskHistory, TaskSummary } from "./types.ts";

export class DovoError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DovoError";
    this.cause = cause;
  }
}

export interface CreateTaskInput {
  projectId: string;
  providerId: string;
  prompt: string;
}

/**
 * Internal contract for everything the TUI needs. Implementations:
 * - RuntimeClient: real Dovo runtime (HTTP + /ws/sync), see runtime-client.ts
 * - MockClient: deterministic fake, used by the smoke test.
 * All methods reject with DovoError; events are pushed, never polled.
 */
export interface DovoClient {
  onEvent: ((event: TaskEvent) => void) | null;
  onConnection: ((connected: boolean) => void) | null;
  /** Fired on any sync delta so the app can debounced-refresh list data. */
  onSync: (() => void) | null;

  /** Open the realtime channel; safe to call once after construction. */
  connect(): void;
  close(): void;
  /** Retarget full thread detail + activity to one task (null = none). */
  focusTask(taskId: string | null): void;

  listProjects(): Promise<Project[]>;
  listTasks(): Promise<TaskSummary[]>;
  listProviders(): Promise<AgentProvider[]>;
  getTaskHistory(taskId: string): Promise<TaskHistory>;
  createTask(input: CreateTaskInput): Promise<TaskSummary>;
  sendMessage(taskId: string, text: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  /** Archive hides the task (reversible); restore brings it back. */
  setTaskArchived(taskId: string, archived: boolean): Promise<void>;
  /** Permanently removes the task and its history. */
  deleteTask(taskId: string): Promise<void>;
  /** Resolve an approval/question item with an option id or free text. */
  answerItem(taskId: string, itemId: string, answer: string): Promise<void>;
}

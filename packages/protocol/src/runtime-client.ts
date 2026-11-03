// The seam of the whole app: what a runtime can do, and nothing about how.
// The TUI and the local runtime server both depend only on this interface.
//
// Implementations (each owns its transport, policy, and wire mapping):
//   createDovoClient    real Dovo Studio runtime        (client/dovo.ts)
//   createDemoClient    scripted in-memory runtime      (client/demo.ts)
//   createRuntimeClient local runtime server, over HTTP + /ws/sync (client/loopback.ts)
//
// Every method rejects with DovoError. Realtime data arrives via subscribe,
// never polling. Implementations must release everything on close(): sockets,
// timers, subscriptions; close() resolves when nothing is left running.
import type { SyncListener, Unsubscribe } from "./sync.ts";
import type {
  AgentProvider,
  CreateTaskInput,
  Device,
  DeviceDecision,
  Invite,
  ModelOption,
  Project,
  ServicePort,
  TaskHistory,
  TaskSummary,
} from "./workspace.ts";

/** Tasks hidden by archiving; they are not part of `listTasks`. */
export interface ArchiveStore {
  list(): Promise<TaskSummary[]>;
}

/** Who may connect to the runtime: paired and waiting devices, and invitations. */
export interface DeviceDirectory {
  /** Paired and waiting devices. */
  list(): Promise<Device[]>;
  /** A short-lived code that a new device enters to ask for access. */
  invite(): Promise<Invite>;
  decide(deviceId: string, decision: DeviceDecision): Promise<void>;
}

/** Web services the projects' processes are serving, where each project lives. */
export interface PortDirectory {
  list(): Promise<ServicePort[]>;
}

/**
 * What every runtime can do. Abilities that only some runtimes have are the
 * optional properties: when one is absent, that runtime cannot do it, and the
 * caller says so instead of being handed an empty answer that means nothing.
 */
export interface RuntimeClient {
  /** Realtime frames (task events, connection state, sync hints). */
  subscribe(listener: SyncListener): Unsubscribe;
  /** Open the realtime channel; safe to call once after construction. */
  connect(): void;
  close(): void;
  /** Retarget full thread detail + activity to one task (null = none). */
  focusTask(taskId: string | null): void;

  listProjects(): Promise<Project[]>;
  listTasks(): Promise<TaskSummary[]>;
  listProviders(): Promise<AgentProvider[]>;
  /** Models a provider offers; empty means its model is fixed or it offers no choice. */
  listModels(providerId: string): Promise<ModelOption[]>;
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

  readonly archive?: ArchiveStore | undefined;
  readonly devices?: DeviceDirectory | undefined;
  readonly ports?: PortDirectory | undefined;
}

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
import type { SyncListener, Unsubscribe } from "dovo-terminal/protocol/sync.ts";
import type {
    AgentProvider,
    CreateTaskInput,
    Project,
    TaskHistory,
    TaskSummary,
} from "dovo-terminal/protocol/workspace.ts";

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

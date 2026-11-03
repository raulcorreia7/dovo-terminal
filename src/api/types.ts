// Internal view model. Deliberately NOT the wire shapes: the adapter in
// client.ts maps runtime payloads onto these types so the TUI never depends on
// protocol details. Field names mirror Dovo concepts, not JSON paths.

export interface Project {
  id: string;
  name: string;
  path: string;
}

export type TaskStatus =
  | "running"
  | "waiting" // awaiting approval or user answer
  | "idle" // finished turn, resumable
  | "error"
  | "unknown";

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  provider: string;
  updatedAt: number;
  activeRunId?: string;
}

export interface AgentProvider {
  id: string;
  label: string;
}

// One rendered entry in a task conversation. Append-only: streaming updates
// replace the trailing assistant item's text, never rewrite history.
export type ConversationItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      detail: string;
      state: "running" | "ok" | "error";
    }
  | {
      kind: "approval";
      id: string;
      title: string;
      detail: string;
      options: { id: string; label: string }[];
      answered: string | null;
    }
  | { kind: "system"; id: string; text: string };

// Realtime events the task screen consumes; the sync-WS bridge produces these.
export type TaskEvent =
  | { type: "item.append"; taskId: string; item: ConversationItem }
  | { type: "item.update"; taskId: string; item: ConversationItem }
  | { type: "status"; taskId: string; status: TaskStatus; activeRunId?: string }
  | { type: "history.replaced"; taskId: string; items: ConversationItem[] };

export interface TaskHistory {
  items: ConversationItem[];
  status: TaskStatus;
  activeRunId?: string;
}

// Small pure helpers for turning A2A messages into text and Dovo events into A2A states.
import { randomUUID } from "node:crypto";
import { type Message, Role, TaskState } from "@a2a-js/sdk";
import type { TaskEvent } from "@dovo-terminal/protocol/sync.ts";
import type { ConversationItem } from "@dovo-terminal/protocol/workspace.ts";

/** The text of a message: its text parts, joined. */
export function textOf(message: Message | undefined): string {
  return (message?.parts ?? [])
    .flatMap((part) => (part.content?.$case === "text" ? [part.content.value] : []))
    .join("\n")
    .trim();
}

export function agentMessage(
  text: string,
  contextId: string,
  taskId: string,
  metadata?: Record<string, unknown>,
): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      },
    ],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** The assistant's words so far, in conversation order. */
export function assistantText(items: ReadonlyMap<string, ConversationItem>): string {
  return [...items.values()]
    .flatMap((item) => (item.kind === "assistant" ? [item.text] : []))
    .join("\n\n")
    .trim();
}

/** What a person is being asked, so a remote caller can show it and answer by id. */
export interface PendingApproval {
  id: string;
  title: string;
  detail: string;
  options: { id: string; label: string }[];
}

export function pendingApprovals(items: ReadonlyMap<string, ConversationItem>): PendingApproval[] {
  return [...items.values()].flatMap((item) =>
    item.kind === "approval" && item.answered === null
      ? [{ id: item.id, title: item.title, detail: item.detail, options: item.options }]
      : [],
  );
}

/** The A2A state a Dovo status ends a turn in, or nothing while the run goes on. */
export function endingState(status: string): TaskState | undefined {
  if (status === "waiting") {
    return TaskState.TASK_STATE_INPUT_REQUIRED;
  }
  if (status === "idle") {
    return TaskState.TASK_STATE_COMPLETED;
  }
  if (status === "error") {
    return TaskState.TASK_STATE_FAILED;
  }

  return undefined;
}

/** Keep what a run says; report the state if this event ended the turn. */
export function remember(
  items: Map<string, ConversationItem>,
  event: TaskEvent,
): TaskState | undefined {
  if (event.type === "status") {
    return endingState(event.status);
  }
  if (event.type === "history.replaced") {
    items.clear();
    for (const item of event.items) {
      items.set(item.id, item);
    }
  } else {
    items.set(event.item.id, event.item);
  }

  return undefined;
}

// A2A on one side, Dovo's conversation model on the other. Pure functions: what
// a worker's task and messages look like to the terminal.
import { type Message, Role, type Task, TaskState } from "@a2a-js/sdk";
import type { ConversationItem, TaskStatus } from "@dovo-terminal/protocol/workspace.ts";
import { z } from "zod";
import { textOf } from "./a2a-text.ts";

/** An approval a worker is asking about, as the executor puts it in message metadata. */
const ApprovalsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    detail: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
);

/** A2A state to the status the terminal shows. */
export function statusOf(state: TaskState | undefined): TaskStatus {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
    case TaskState.TASK_STATE_WORKING:
      return "running";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "waiting";
    case TaskState.TASK_STATE_COMPLETED:
    case TaskState.TASK_STATE_CANCELED:
      return "idle";
    case TaskState.TASK_STATE_FAILED:
    case TaskState.TASK_STATE_REJECTED:
      return "error";
    default:
      return "unknown";
  }
}

/** The approvals a worker attached to a message, validated; anything malformed is ignored. */
export function approvalsIn(message: Message | undefined): ConversationItem[] {
  const parsed = ApprovalsSchema.safeParse(message?.metadata?.["approvals"]);

  return parsed.success
    ? parsed.data.map((approval) => ({ kind: "approval", ...approval, answered: null }))
    : [];
}

/** What one message says, as conversation items: its text, then any approvals it asks. */
export function itemsOf(message: Message | undefined): ConversationItem[] {
  if (!message) {
    return [];
  }
  const text = textOf(message);
  const own: ConversationItem[] = [];
  if (text) {
    own.push(
      message.role === Role.ROLE_USER
        ? { kind: "user", id: message.messageId, text }
        : { kind: "assistant", id: message.messageId, text, done: true },
    );
  }

  return [...own, ...approvalsIn(message)];
}

/** A task's whole conversation: its history, then the message on its current status. */
export function conversationOf(task: Task): ConversationItem[] {
  const seen = new Set<string>();
  const items = [...task.history, ...(task.status?.message ? [task.status.message] : [])]
    .flatMap((message) => itemsOf(message))
    .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));

  return items;
}

/** A user message for a task, optionally carrying metadata for the worker. */
export function userMessage(
  text: string,
  options: { taskId?: string; contextId?: string; metadata?: Record<string, unknown> } = {},
): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: options.contextId ?? "",
    taskId: options.taskId ?? "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      },
    ],
    metadata: options.metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

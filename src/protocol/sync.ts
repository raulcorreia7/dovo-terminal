// Realtime contract, named after Dovo's own channel (/ws/sync). Push-only:
// implementations never get polled. The same frame union flows over three
// hops unchanged: upstream adapter -> local server -> /ws/sync -> TUI.

import { ConversationItemSchema, TaskStatusSchema } from "dovo-terminal/protocol/workspace.ts";
import { z } from "zod";

export const TaskEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item.append"), taskId: z.string(), item: ConversationItemSchema }),
  z.object({ type: z.literal("item.update"), taskId: z.string(), item: ConversationItemSchema }),
  z.object({
    type: z.literal("status"),
    taskId: z.string(),
    status: TaskStatusSchema,
    activeRunId: z.string().optional(),
  }),
  z.object({
    type: z.literal("history.replaced"),
    taskId: z.string(),
    items: z.array(ConversationItemSchema),
  }),
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

// Upstream reachability as an explicit lifecycle, not booleans: every client
// shares this machine, so the header can tell "connecting", "reconnecting" and
// "offline" apart, and an illegal transition becomes impossible to emit.
export const ConnectionPhaseSchema = z.enum(["connecting", "online", "reconnecting", "offline"]);
export type ConnectionPhase = z.infer<typeof ConnectionPhaseSchema>;

export const SyncFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: TaskEventSchema }),
  // The runtime's lifecycle advanced (header dot, retry hints).
  z.object({ type: z.literal("connection"), state: ConnectionPhaseSchema }),
  // A data delta landed somewhere; debounced-refresh list/history data.
  z.object({ type: z.literal("sync") }),
]);
export type SyncFrame = z.infer<typeof SyncFrameSchema>;

export type SyncListener = (frame: SyncFrame) => void;
export type Unsubscribe = () => void;

// Realtime contract, named after Dovo's own channel (/ws/sync). Push-only:
// implementations never get polled. The same frame union flows over three
// hops unchanged: upstream adapter -> local server -> /ws/sync -> TUI.
import { z } from "zod";
import { ConversationItemSchema, TaskStatusSchema } from "./workspace.ts";

export const TaskEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item.append"), taskId: z.string(), item: ConversationItemSchema }),
  z.object({ type: z.literal("item.update"), taskId: z.string(), item: ConversationItemSchema }),
  z.object({
    type: z.literal("status"),
    taskId: z.string(),
    status: TaskStatusSchema,
    activeRunId: z.string().optional(),
  }),
  z.object({ type: z.literal("history.replaced"), taskId: z.string(), items: z.array(ConversationItemSchema) }),
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const SyncFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: TaskEventSchema }),
  // Upstream reachability changed (header dot).
  z.object({ type: z.literal("connection"), connected: z.boolean() }),
  // A data delta landed somewhere; debounced-refresh list/history data.
  z.object({ type: z.literal("sync") }),
]);
export type SyncFrame = z.infer<typeof SyncFrameSchema>;

export type SyncListener = (frame: SyncFrame) => void;
export type Unsubscribe = () => void;

/** Minimal typed fan-out used by every RuntimeClient and the local server. */
export class SyncSink {
  private listeners = new Set<SyncListener>();

  subscribe(listener: SyncListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(frame: SyncFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  clear(): void {
    this.listeners.clear();
  }
}

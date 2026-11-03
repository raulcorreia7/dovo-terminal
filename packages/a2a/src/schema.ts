// The worker's tables, as TypeScript. `drizzle-kit generate` turns changes to
// this file into the migration files under ../drizzle; nobody writes SQL by hand.
// biome-ignore lint/suspicious/noDeprecatedImports: only the old positional overload of primaryKey is deprecated; the object form below is current
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The SDK's task records. `data` is the whole task, as JSON. */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  contextId: text("context_id").notNull(),
  state: integer("state"),
  updatedAt: text("updated_at"),
  data: text("data").notNull(),
});

/** Which Dovo task an A2A task became. `dovoTaskId` is empty until creation is confirmed. */
export const runs = sqliteTable("runs", {
  a2aTaskId: text("a2a_task_id").primaryKey(),
  dovoTaskId: text("dovo_task_id"),
});

/** Message ids already handled, so a redelivery cannot repeat what the message did. */
export const messages = sqliteTable("messages", {
  messageId: text("message_id").primaryKey(),
  a2aTaskId: text("a2a_task_id").notNull(),
});

/** The plan an orchestrator is running, as JSON, so a restart can carry on with it. */
export const plans = sqliteTable("plans", {
  a2aTaskId: text("a2a_task_id").primaryKey(),
  plan: text("plan").notNull(),
});

/** One step's progress: its worker task once started, its outcome once done. */
export const steps = sqliteTable(
  "steps",
  {
    a2aTaskId: text("a2a_task_id").notNull(),
    stepId: text("step_id").notNull(),
    workerTaskId: text("worker_task_id"),
    state: text("state"),
    text: text("text"),
  },
  (table) => [primaryKey({ columns: [table.a2aTaskId, table.stepId] })],
);

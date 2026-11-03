// What a worker must remember across a restart, in SQLite through Drizzle ORM:
// the SDK's task records, which Dovo task an A2A task became, which message ids
// were already handled, and an orchestrator's plan and step progress. Together
// these stop a redelivered message from creating a second Dovo task and let an
// interrupted plan carry on. Tables are TypeScript (schema.ts); their migration
// is generated, and applied here when the database is opened.
import type { TaskStore } from "@a2a-js/sdk/server";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { messages, plans, runs, steps } from "./schema.ts";
import { SqlTaskStore } from "./task-store.ts";

/** A run whose Dovo task id is unknown: creation began but was never confirmed. */
export interface Run {
  dovoTaskId: string | null;
}

/** What the orchestrator knows about one step of a plan it is running. */
export interface SavedStep {
  workerTaskId: string | null;
  /** Set once the step has an outcome; absent while it is still running. */
  state: string | null;
  text: string | null;
}

const MIGRATIONS = new URL("../drizzle", import.meta.url).pathname;

export class WorkerStore {
  private readonly sqlite: Database.Database;
  private readonly db: BetterSQLite3Database;

  private constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
    this.db = drizzle(sqlite);
  }

  /** Open (creating and migrating if needed) the worker's database file. */
  static open(path: string): Promise<WorkerStore> {
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    const store = new WorkerStore(sqlite);
    migrate(store.db, { migrationsFolder: MIGRATIONS });

    return Promise.resolve(store);
  }

  /** The SDK's task store, backed by the same database. */
  taskStore(): TaskStore {
    return new SqlTaskStore(this.db);
  }

  runOf(a2aTaskId: string): Promise<Run | undefined> {
    const row = this.db.select().from(runs).where(eq(runs.a2aTaskId, a2aTaskId)).get();

    return Promise.resolve(row && { dovoTaskId: row.dovoTaskId });
  }

  /** Which A2A task a message id was already handled for, if any. */
  taskOfMessage(messageId: string): Promise<string | undefined> {
    const row = this.db.select().from(messages).where(eq(messages.messageId, messageId)).get();

    return Promise.resolve(row?.a2aTaskId);
  }

  /** Note the message as handled before acting on it, so a retry cannot repeat the action. */
  recordMessage(messageId: string, a2aTaskId: string): Promise<void> {
    this.db.insert(messages).values({ messageId, a2aTaskId }).onConflictDoNothing().run();

    return Promise.resolve();
  }

  /** Note that a Dovo task is about to be created for this A2A task. */
  beginRun(a2aTaskId: string): Promise<void> {
    this.db.insert(runs).values({ a2aTaskId, dovoTaskId: null }).onConflictDoNothing().run();

    return Promise.resolve();
  }

  attachRun(a2aTaskId: string, dovoTaskId: string): Promise<void> {
    this.db.update(runs).set({ dovoTaskId }).where(eq(runs.a2aTaskId, a2aTaskId)).run();

    return Promise.resolve();
  }

  /** Keep the plan an orchestrator is running, so a restart can carry on with it. */
  savePlan(a2aTaskId: string, plan: string): Promise<void> {
    this.db.insert(plans).values({ a2aTaskId, plan }).onConflictDoNothing().run();

    return Promise.resolve();
  }

  loadPlan(a2aTaskId: string): Promise<string | undefined> {
    const row = this.db.select().from(plans).where(eq(plans.a2aTaskId, a2aTaskId)).get();

    return Promise.resolve(row?.plan);
  }

  /** Record a step's progress: its worker task once started, its outcome once done. */
  saveStep(a2aTaskId: string, stepId: string, progress: Partial<SavedStep>): Promise<void> {
    this.db
      .insert(steps)
      .values({ a2aTaskId, stepId, ...progress })
      .onConflictDoUpdate({ target: [steps.a2aTaskId, steps.stepId], set: progress })
      .run();

    return Promise.resolve();
  }

  loadSteps(a2aTaskId: string): Promise<Map<string, SavedStep>> {
    const rows = this.db.select().from(steps).where(eq(steps.a2aTaskId, a2aTaskId)).all();

    return Promise.resolve(
      new Map(
        rows.map((row) => [
          row.stepId,
          { workerTaskId: row.workerTaskId, state: row.state, text: row.text },
        ]),
      ),
    );
  }

  close(): Promise<void> {
    this.sqlite.close();

    return Promise.resolve();
  }
}

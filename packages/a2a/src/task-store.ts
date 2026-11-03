import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import { and, desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { tasks } from "./schema.ts";

const DEFAULT_PAGE = 50;

/** The SDK's task store, over the `tasks` table. A task is kept whole, as JSON. */
export class SqlTaskStore implements TaskStore {
  private readonly db: BetterSQLite3Database;

  constructor(db: BetterSQLite3Database) {
    this.db = db;
  }

  save(task: Task): Promise<void> {
    const row = {
      id: task.id,
      contextId: task.contextId,
      state: task.status?.state ?? null,
      updatedAt: task.status?.timestamp ?? null,
      data: JSON.stringify(task),
    };
    this.db.insert(tasks).values(row).onConflictDoUpdate({ target: tasks.id, set: row }).run();

    return Promise.resolve();
  }

  load(taskId: string): Promise<Task | undefined> {
    const row = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();

    return Promise.resolve(row && (JSON.parse(row.data) as Task));
  }

  /** Newest first; `pageToken` is the offset to continue from. */
  list(params: ListTasksRequest): Promise<ListTasksResponse> {
    const size = params.pageSize ?? DEFAULT_PAGE;
    const from = Number(params.pageToken) || 0;
    const where = and(
      params.contextId ? eq(tasks.contextId, params.contextId) : undefined,
      params.status ? eq(tasks.state, params.status) : undefined,
    );
    const rows = this.db
      .select()
      .from(tasks)
      .where(where)
      .orderBy(desc(tasks.updatedAt))
      .limit(size)
      .offset(from)
      .all();
    const total =
      this.db.select({ n: sql<number>`count(*)` }).from(tasks).where(where).get()?.n ?? 0;

    return Promise.resolve({
      tasks: rows.map((row) => JSON.parse(row.data) as Task),
      nextPageToken: from + size < total ? String(from + size) : "",
      pageSize: size,
      totalSize: total,
    });
  }
}

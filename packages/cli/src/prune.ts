// Delete archived tasks that have sat untouched for a while. Archiving is the
// reversible step; this is the permanent one, so it defaults to a dry run.
import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import { UnsupportedError } from "@dovo-terminal/protocol/unsupported-error.ts";
import type { TaskSummary } from "@dovo-terminal/protocol/workspace.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const AGE = /^(?<count>\d+)(?<unit>[hd])$/u;

/** "30d" or "12h" in milliseconds. Anything else is an error, never a guess. */
export function parseAge(text: string): number {
  const match = AGE.exec(text.trim());
  const count = Number(match?.groups?.["count"]);
  if (!match || count < 1) {
    throw new Error(`age must look like 30d or 12h, not "${text}"`);
  }

  return count * (match.groups?.["unit"] === "d" ? DAY_MS : HOUR_MS);
}

export interface PruneReport {
  /** Archived tasks old enough to go. */
  candidates: TaskSummary[];
  /** How many were deleted (always 0 on a dry run). */
  deleted: number;
  failures: string[];
}

/** Archived tasks whose last activity is older than `olderThanMs`. */
export function selectOld(
  archived: readonly TaskSummary[],
  olderThanMs: number,
  now: number,
): TaskSummary[] {
  return archived.filter((task) => now - task.updatedAt > olderThanMs);
}

export async function prune(
  client: Pick<RuntimeClient, "archive" | "deleteTask">,
  olderThanMs: number,
  options: { apply: boolean; now?: number },
): Promise<PruneReport> {
  if (!client.archive) {
    throw new UnsupportedError("this machine cannot list archived tasks");
  }
  const archived = await client.archive.list();
  const candidates = selectOld(archived, olderThanMs, options.now ?? Date.now());
  const report: PruneReport = { candidates, deleted: 0, failures: [] };
  if (!options.apply) {
    return report;
  }
  for (const task of candidates) {
    try {
      // one at a time on purpose: a deletion is permanent, so stop being
      // surprised by a burst, and keep failures in task order.
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design
      await client.deleteTask(task.id);
      report.deleted += 1;
    } catch (error) {
      report.failures.push(`${task.title || task.id}: ${errorMessage(error)}`);
    }
  }

  return report;
}

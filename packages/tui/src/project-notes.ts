import type { Project } from "@dovo-terminal/protocol/workspace.ts";

export type NoteLookup = (project: Project) => Promise<string | undefined>;

/**
 * Refresh `notes` (project id -> one line of outside status) in place.
 * Lookups run together, so one slow project does not delay the rest.
 * Returns whether anything changed, so the caller redraws only when needed.
 */
export async function refreshNotes(
  projects: readonly Project[],
  lookup: NoteLookup,
  notes: Map<string, string>,
): Promise<boolean> {
  const found = await Promise.all(
    projects.map(async (project) => [project.id, await lookup(project)] as const),
  );
  let changed = false;
  for (const [id, note] of found) {
    if (note === notes.get(id)) {
      continue;
    }
    changed = true;
    if (note) {
      notes.set(id, note);
    } else {
      notes.delete(id);
    }
  }

  return changed;
}

// The task list is a tree: projects hold tasks, and a project can be folded
// away. This file is the pure part: which rows exist for a given collapse state
// and filter. The screen turns rows into list items and keys into actions.
import type { Project, TaskSummary } from "@dovo-terminal/protocol/workspace.ts";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export interface ProjectRow {
  readonly kind: "project";
  readonly project: { readonly id: string; readonly name: string };
  readonly collapsed: boolean;
  readonly total: number;
  readonly running: number;
  readonly waiting: number;
  /** Extra status from outside the runtime, e.g. a pull request. */
  readonly note?: string | undefined;
}

export interface TaskRow {
  readonly kind: "task";
  readonly task: TaskSummary;
  readonly projectName: string;
}

export type TreeRow = ProjectRow | TaskRow;

export const PROJECT_PREFIX = "project:";

/** The id a list item carries for a row: the task id, or a prefixed project id. */
export function rowKey(row: TreeRow): string {
  if (row.kind === "project") {
    return PROJECT_PREFIX + row.project.id;
  }

  return row.task.id;
}

const UNKNOWN_PROJECT = "?";

function newestFirst(a: TaskSummary, b: TaskSummary): number {
  return b.updatedAt - a.updatedAt;
}

function tasksByProject(tasks: readonly TaskSummary[]): Map<string, TaskSummary[]> {
  const grouped = new Map<string, TaskSummary[]>();
  for (const task of [...tasks].sort(newestFirst)) {
    grouped.set(task.projectId, [...(grouped.get(task.projectId) ?? []), task]);
  }

  return grouped;
}

/** Filter: a flat, best-match-first list across every project, folded or not. */
function matchingRows(
  tasks: readonly TaskSummary[],
  names: ReadonlyMap<string, string>,
  query: string,
): TaskRow[] {
  const rows: TaskRow[] = tasks.map((task) => ({
    kind: "task",
    task,
    projectName: names.get(task.projectId) ?? UNKNOWN_PROJECT,
  }));

  return fuzzyFilter(
    rows,
    query,
    (row) => `${row.task.title} ${row.projectName} ${row.task.provider}`,
  );
}

/**
 * Rows to show. With no query: each project (most recently active first, empty
 * ones last) followed by its tasks unless folded. With a query: matching tasks only.
 */
/** What the list is showing right now: which projects are folded, the search, outside notes. */
export interface RowView {
  collapsed: ReadonlySet<string>;
  query: string;
  notes?: ReadonlyMap<string, string>;
}

export function buildRows(
  projects: readonly Project[],
  tasks: readonly TaskSummary[],
  view: RowView,
): TreeRow[] {
  const { collapsed, query, notes = new Map() } = view;
  const names = new Map(projects.map((project) => [project.id, project.name]));
  if (query) {
    return matchingRows(tasks, names, query);
  }

  const grouped = tasksByProject(tasks);
  const known = new Set(projects.map((project) => project.id));
  const orphans = [...grouped.keys()].filter((id) => !known.has(id));
  const owners = [
    ...projects.map((project) => ({ id: project.id, name: project.name })),
    ...orphans.map((id) => ({ id, name: UNKNOWN_PROJECT })),
  ].sort(
    (a, b) => (grouped.get(b.id)?.[0]?.updatedAt ?? 0) - (grouped.get(a.id)?.[0]?.updatedAt ?? 0),
  );

  return owners.flatMap((owner) => {
    const own = grouped.get(owner.id) ?? [];
    const isCollapsed = collapsed.has(owner.id);
    const header: ProjectRow = {
      kind: "project",
      project: owner,
      collapsed: isCollapsed,
      total: own.length,
      running: own.filter((task) => task.status === "running").length,
      waiting: own.filter((task) => task.status === "waiting").length,
      ...(notes.has(owner.id) && { note: notes.get(owner.id) }),
    };
    if (isCollapsed) {
      return [header];
    }

    return [
      header,
      ...own.map((task): TaskRow => ({ kind: "task", task, projectName: owner.name })),
    ];
  });
}

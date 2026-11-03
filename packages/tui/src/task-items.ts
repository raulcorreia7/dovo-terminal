import type { SelectItem } from "@earendil-works/pi-tui";
import { statusGlyph } from "./status.ts";
import { PROJECT_PREFIX, rowKey, type TreeRow } from "./task-rows.ts";
import { colors, t } from "./theme/index.ts";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < MINUTE) {
    return `${seconds}s`;
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}m`;
  }
  if (seconds < DAY) {
    return `${Math.floor(seconds / HOUR)}h`;
  }

  return `${Math.floor(seconds / DAY)}d`;
}

function plural(count: number, noun: string): string {
  if (count === 1) {
    return `${count} ${noun}`;
  }

  return `${count} ${noun}s`;
}

function projectDescription(row: TreeRow & { kind: "project" }): string {
  const parts = [plural(row.total, "task")];
  if (row.running > 0) {
    parts.push(t(`${row.running} running`, colors.ok));
  }
  if (row.waiting > 0) {
    parts.push(t(`${row.waiting} waiting`, colors.warn));
  }

  if (row.note) {
    parts.push(t(row.note, colors.user));
  }

  return parts.join(" · ");
}

/** A tree row as a list item: a fold marker for projects, an indent for tasks. */
export function toSelectItem(row: TreeRow, showProject: boolean): SelectItem {
  if (row.kind === "project") {
    const marker = t(row.collapsed ? "▸" : "▾", colors.accent);

    return {
      value: rowKey(row),
      label: `${marker} ${t(row.project.name, colors.text, { bold: true })}`,
      description: projectDescription(row),
    };
  }

  const { task } = row;
  const where = showProject ? `${row.projectName} · ` : "";
  const prefix = showProject ? "" : "  ";

  return {
    value: task.id,
    label: `${prefix}${statusGlyph(task.status)} ${task.title || "(untitled task)"}`,
    description: `${where}${task.provider} · ${relativeTime(task.updatedAt)} ago`,
  };
}

export function isProjectKey(value: string): boolean {
  return value.startsWith(PROJECT_PREFIX);
}

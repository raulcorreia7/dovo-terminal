import type { TaskStatus } from "@dovo-terminal/protocol/workspace.ts";
import { colors, t } from "./theme/index.ts";
import type { Palette } from "./theme/palette.ts";

interface StatusStyle {
  readonly glyph: string;
  readonly words: string;
  readonly role: keyof Palette;
}

const STATUS_STYLES: Record<TaskStatus, StatusStyle> = {
  running: { glyph: "●", words: "running", role: "ok" },
  waiting: { glyph: "●", words: "waiting for you", role: "warn" },
  idle: { glyph: "○", words: "idle", role: "muted" },
  error: { glyph: "✗", words: "error", role: "error" },
  unknown: { glyph: "?", words: "unknown", role: "dim" },
};

/** The coloured one-character marker for a task status. */
export function statusGlyph(status: TaskStatus): string {
  const style = STATUS_STYLES[status];

  return t(style.glyph, colors[style.role]);
}

/** Marker plus words, e.g. "● running", in the status colour. */
export function statusLabel(status: TaskStatus): string {
  const style = STATUS_STYLES[status];

  return t(`${style.glyph} ${style.words}`, colors[style.role]);
}

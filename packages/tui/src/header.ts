import type { ConnectionPhase } from "@dovo-terminal/protocol/sync.ts";
import { colors, t } from "./theme/index.ts";

export interface HeaderState {
  phase: ConnectionPhase;
  projectCount: number;
  taskCount: number;
  statusNote: string;
  screenId: string;
}

function connectionDot(phase: ConnectionPhase): string {
  if (phase === "online") {
    return t("●", colors.ok);
  }
  if (phase === "connecting" || phase === "reconnecting") {
    return t("●", colors.warn);
  }

  return t("●", colors.error);
}

function countsText(state: HeaderState): string {
  if (state.projectCount === 0) {
    return "—";
  }

  return `${state.taskCount} tasks · ${state.projectCount} projects`;
}

function keysHint(screenId: string): string {
  if (screenId === "task") {
    return t(" esc back  ctrl+c stop", colors.dim);
  }

  return t(" n new  t theme  r refresh  ? help  ctrl+q quit", colors.dim);
}

/** The one-line header: brand, connection, counts, and the keys that matter here. */
export function headerText(state: HeaderState): string {
  const note = state.statusNote ? ` · ${state.statusNote}` : "";

  return (
    t("dovo", colors.accent, { bold: true }) +
    ` ${connectionDot(state.phase)}${note}` +
    t(`  ${countsText(state)}`, colors.muted) +
    keysHint(state.screenId)
  );
}

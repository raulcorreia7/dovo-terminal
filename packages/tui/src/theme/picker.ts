import { type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { selectListTheme, type ThemeEntry, t } from "./index.ts";

/** The setting that follows the terminal's light/dark scheme instead of naming a theme. */
export const AUTO_THEME = "auto";

const SWATCH_ROLES = ["accent", "user", "ok", "warn", "error"] as const;

function swatch(entry: ThemeEntry): string {
  return SWATCH_ROLES.map((role) => t("●", entry.palette[role])).join(" ");
}

/** A theme list with a colour swatch per row; the current choice is marked. */
export function createThemePicker(
  entries: readonly ThemeEntry[],
  current: string,
  onPick: (id: string) => void,
  onCancel: () => void,
): SelectList {
  const items: SelectItem[] = [
    { value: AUTO_THEME, label: "auto", description: "follow the terminal's light/dark scheme" },
    ...entries.map((entry) => ({
      value: entry.id,
      label: entry.label,
      description: swatch(entry),
    })),
  ].map((item) => ({ ...item, label: item.value === current ? `${item.label}  ✓` : item.label }));
  const list = new SelectList(items, Math.min(12, items.length), selectListTheme);
  const selected = items.findIndex((item) => item.value === current);
  list.setSelectedIndex(Math.max(0, selected));
  list.onSelect = (item) => onPick(item.value);
  list.onCancel = onCancel;

  return list;
}

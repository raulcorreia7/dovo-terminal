import { Container, Text } from "@earendil-works/pi-tui";
import { type KeyOverrides, keyFor, type ListAction, shown } from "./keys.ts";
import { colors, t } from "./theme/index.ts";

/** The help rows. Keys that can be remapped are read from the live bindings. */
function helpRows(keys: KeyOverrides): [string, string][] {
  const key = (action: ListAction) => shown(keyFor(action, keys));

  return [
    ["↑/↓", "browse tasks"],
    [key("search"), "search every project (esc clears)"],
    [`${key("unfold")} / ${key("fold")}`, "unfold / fold the selected project"],
    ["enter", "open task · fold or unfold a project"],
    ["a", "answer the pending approval or question"],
    [key("new"), "new task (project → agent → model → prompt)"],
    [key("archive"), "archive the selected task (reversible)"],
    [key("delete"), "delete the selected task permanently"],
    [key("refresh"), "refresh"],
    [key("theme"), "choose a colour theme"],
    [key("invite"), "invite a device, approve or revoke devices"],
    [key("machines"), "is everything working? health of every machine"],
    [key("open"), "open a web service the project is running"],
    [key("shell"), "open a shell in the project's folder, on its machine"],
    [key("help"), "this help"],
    ["esc", "back / dismiss"],
    ["ctrl+c", "stop the running task"],
    ["ctrl+q", "quit"],
  ];
}

/** Static shortcut reference; any key closes (App routes input first). */
export class HelpView extends Container {
  onKey: () => void = () => undefined;

  constructor(keys: KeyOverrides = {}) {
    super();
    const lines = [
      t(" dovo-terminal keys", colors.accent, { bold: true }),
      "",
      ...helpRows(keys).map(
        ([key, what]) =>
          `   ${t(key.padEnd(8), colors.text, { bold: true })}${t(what, colors.muted)}`,
      ),
      "",
      t("   press any key to close", colors.dim),
    ];
    this.addChild(new Text(lines.join("\n"), 1, 0));
  }

  handleInput(): void {
    this.onKey();
  }
}

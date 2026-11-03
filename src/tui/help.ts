import { Container, Text } from "@earendil-works/pi-tui";
import { colors, t } from "dovo-terminal/tui/theme.ts";

const rows: [string, string][] = [
    ["↑/↓", "browse tasks · type to filter"],
    ["/", "filter box (esc clears)"],
    ["enter", "open task / choose"],
    ["a", "answer the pending approval or question"],
    ["n", "new task (project → agent → prompt)"],
    ["d", "archive the selected task (reversible)"],
    ["D", "delete the selected task permanently"],
    ["r", "refresh"],
    ["?", "this help"],
    ["esc", "back / dismiss"],
    ["ctrl+c", "stop the running task"],
    ["ctrl+q", "quit"],
];

/** Static shortcut reference; any key closes (App routes input first). */
export class HelpView extends Container {
    onKey: () => void = () => undefined;

    constructor() {
        super();
        const lines = [
            t(" dovo-terminal keys", colors.accent, { bold: true }),
            "",
            ...rows.map(
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

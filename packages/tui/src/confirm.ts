import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { colors, t } from "dovo-terminal/tui/theme.ts";

/** Archive/delete gate: y or enter acts, anything else cancels. */
export class ConfirmPrompt extends Container {
  onAnswer: (accept: boolean) => void = () => undefined;

  constructor(taskTitle: string, permanently: boolean) {
    super();
    const verb = permanently
      ? t("delete permanently", colors.error, { bold: true })
      : t("archive", colors.warn);
    this.addChild(
      new Text(
        [
          ` ${verb} ${t(`"${taskTitle || "(untitled)"}"`, colors.text, { bold: true })}?`,
          "",
          `   ${t("y", colors.text, { bold: true })}${t(" confirm   ", colors.muted)}${t("any other key", colors.text, { bold: true })}${t(" cancel", colors.muted)}`,
        ].join("\n"),
        1,
        0,
      ),
    );
  }

  handleInput(data: string): boolean {
    const accept = matchesKey(data, "y") || matchesKey(data, Key.enter);
    this.onAnswer(accept);
    return true;
  }
}

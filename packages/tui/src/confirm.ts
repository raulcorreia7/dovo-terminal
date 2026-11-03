import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { colors, t } from "./theme/index.ts";

/** "archive "x"?" or "delete permanently "x"?": the question for removing a task. */
export function removeHeadline(taskTitle: string, permanently: boolean): string {
  const verb = permanently
    ? t("delete permanently", colors.error, { bold: true })
    : t("archive", colors.warn);

  return `${verb} ${t(`"${taskTitle || "(untitled)"}"`, colors.text, { bold: true })}?`;
}

/** A yes/no gate: y or enter acts, anything else cancels. */
export class ConfirmPrompt extends Container {
  onAnswer: (accept: boolean) => void = () => undefined;

  constructor(headline: string) {
    super();
    this.addChild(
      new Text(
        [
          ` ${headline}`,
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

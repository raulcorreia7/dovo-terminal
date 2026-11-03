import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { colors, t } from "../theme.ts";

export class ApprovalItem implements Component {
  private title: string;
  private detail: string;
  private options: { id: string; label: string }[];
  private answeredLabel: string | null = null;
  constructor(title: string, detail: string, options: { id: string; label: string }[]) {
    this.title = title;
    this.detail = detail;
    this.options = options;
  }
  resolve(answeredLabel: string | null): void {
    this.answeredLabel = answeredLabel;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const head = `   ${t("◆ needs your input:", colors.warn, { bold: true })} ${t(this.title, colors.text)}`;
    const hint = this.hintText();
    const lines = [truncateToWidth(head, width)];
    if (this.detail) {
      lines.push(truncateToWidth(`     ${t(this.detail, colors.muted)}`, width));
    }
    lines.push(truncateToWidth(hint, width));
    return lines;
  }

  private hintText(): string {
    if (this.answeredLabel) {
      return `     ${t(`answered: ${this.answeredLabel}`, colors.ok)}`;
    }
    if (this.options.length > 0) {
      return `     ${t("press a to choose", colors.dim)}`;
    }
    return `     ${t("press a to answer", colors.dim)}`;
  }
}

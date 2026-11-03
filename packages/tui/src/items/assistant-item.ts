import { type Component, Markdown } from "@earendil-works/pi-tui";
import { colors, markdownTheme, t } from "../theme/index.ts";

export class AssistantItem implements Component {
  private view: Markdown;
  constructor(text: string) {
    this.view = new Markdown(text, 0, 0, markdownTheme);
  }
  setText(text: string): void {
    this.view.setText(text);
  }
  invalidate(): void {
    this.view.invalidate();
  }
  render(width: number): string[] {
    if (width <= 3) {
      return [];
    }
    return [
      ` ${t(" dovo ", colors.accent, { bold: true })}`,
      ...this.view.render(width - 3).map((line) => `   ${line}`),
    ];
  }
}

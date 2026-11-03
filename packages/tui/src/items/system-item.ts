import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { colors, t } from "../theme/index.ts";

export class SystemItem implements Component {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  setText(text: string): void {
    this.text = text;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return [truncateToWidth(`   ${t(this.text, colors.dim)}`, width)];
  }
}

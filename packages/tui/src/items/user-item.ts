import { type Component, Text } from "@earendil-works/pi-tui";
import { colors, t } from "../theme/index.ts";

export class UserItem implements Component {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  setText(text: string): void {
    this.text = text;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return new Text(`${t(" you ", colors.user, { bold: true })} ${this.text}`, 1, 0).render(width);
  }
}

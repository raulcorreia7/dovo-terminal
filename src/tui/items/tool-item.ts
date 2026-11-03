import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { assertNever } from "dovo-terminal/protocol/errors.ts";
import { colors, t } from "../theme.ts";

export class ToolItem implements Component {
  private name: string;
  private detail: string;
  private state: "running" | "ok" | "error";
  constructor(name: string, detail: string, state: "running" | "ok" | "error") {
    this.name = name;
    this.detail = detail;
    this.state = state;
  }
  setUpdate(name: string, detail: string, state: "running" | "ok" | "error"): void {
    this.name = name;
    this.detail = detail;
    this.state = state;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const glyph = this.glyph();
    const line = `   ${glyph} ${t(this.name, colors.muted)} ${t(this.detail, colors.dim)}`;
    return [truncateToWidth(line, width)];
  }

  private glyph(): string {
    switch (this.state) {
      case "ok":
        return t("▸", colors.ok);
      case "error":
        return t("✗", colors.error);
      case "running":
        return t("▸", colors.warn);
      default:
        return assertNever(this.state);
    }
  }
}

import {
  Markdown,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { ConversationItem } from "../api/types.ts";
import { colors, markdownTheme, t } from "./theme.ts";

const roleUser = t(" you ", colors.user, { bold: true });
const roleDovo = t(" dovo ", colors.accent, { bold: true });

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
    return new Text(`${roleUser} ${this.text}`, 1, 0).render(width);
  }
}

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
    if (width <= 3) return [];
    return [" " + roleDovo, ...this.view.render(width - 3).map((line) => `   ${line}`)];
  }
}

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
    const glyph =
      this.state === "ok"
        ? t("▸", colors.ok)
        : this.state === "error"
          ? t("✗", colors.error)
          : t("▸", colors.warn);
    const line = `   ${glyph} ${t(this.name, colors.muted)} ${t(this.detail, colors.dim)}`;
    return [truncateToWidth(line, width)];
  }
}

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
    const hint = this.answeredLabel
      ? `     ${t(`answered: ${this.answeredLabel}`, colors.ok)}`
      : this.options.length > 0
        ? `     ${t("press a to choose", colors.dim)}`
        : `     ${t("press a to answer", colors.dim)}`;
    const lines = [truncateToWidth(head, width)];
    if (this.detail) lines.push(truncateToWidth(`     ${t(this.detail, colors.muted)}`, width));
    lines.push(truncateToWidth(hint, width));
    return lines;
  }
}

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

/** Builds the cached renderer for a new conversation item. */
export function createItemView(item: ConversationItem): Component {
  switch (item.kind) {
    case "user":
      return new UserItem(item.text);
    case "assistant":
      return new AssistantItem(item.text);
    case "tool":
      return new ToolItem(item.name, item.detail, item.state);
    case "approval":
      return new ApprovalItem(item.title, item.detail, item.options);
    case "system":
      return new SystemItem(item.text);
  }
}

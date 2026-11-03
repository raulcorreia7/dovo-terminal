import {
  Container,
  Editor,
  Key,
  Loader,
  matchesKey,
  ScrollView,
  SelectList,
  VStack,
  type Component,
  type OverlayHandle,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { TaskEvent } from "../../protocol/sync.ts";
import type { ConversationItem, TaskSummary } from "../../protocol/workspace.ts";
import type { App } from "../app.ts";
import type { Screen } from "../screen.ts";
import { LineText } from "../line.ts";
import { createItemView, ApprovalItem, AssistantItem, SystemItem, ToolItem, UserItem } from "../items.ts";
import { colors, editorBorder, selectListTheme, t } from "../theme.ts";
import { TaskListScreen } from "./tasklist.ts";

const statusText: Record<TaskSummary["status"], string> = {
  running: t("● running", colors.ok),
  waiting: t("● waiting for you", colors.warn),
  idle: t("○ idle", colors.muted),
  error: t("✗ error", colors.error),
  unknown: t("? unknown", colors.dim),
};

export class TaskScreen implements Screen {
  readonly id = "task";
  private readonly transcript = new TranscriptView();
  private readonly scroll: ScrollView;
  private readonly titleBar: LineText;
  private readonly composer: Editor;
  private readonly loader: Loader;
  private taskStatus: TaskSummary["status"];
  private running = false;
  private approvalOverlay: OverlayHandle | null = null;

  private readonly app: App;
  private readonly task: TaskSummary;

  constructor(app: App, task: TaskSummary) {
    this.app = app;
    this.task = task;
    this.taskStatus = task.status;
    this.titleBar = new LineText(this.titleText());
    this.scroll = new ScrollView(this.transcript, { follow: "end", primary: true, scrollbar: "auto" });
    this.composer = new Editor(this.app.tui, {
      borderColor: editorBorder,
      selectList: selectListTheme,
    });
    this.composer.onSubmit = (text) => void this.send(text);
    this.loader = new Loader(
      this.app.tui,
      (s) => t(s, colors.accent),
      (s) => t(s, colors.muted),
      "agent is working",
    );
    this.setRunningUi(task.status === "running");
  }

  build(): { root: VStack; focus?: Component } {
    const root = new VStack();
    root.addChild(this.titleBar, { basis: "auto" });
    root.addChild(this.scroll, { grow: 1, basis: 0 });
    root.addChild(this.loader, { basis: "auto", visible: () => this.running });
    root.addChild(this.composer, { basis: "auto" });
    void this.loadHistory();
    this.app.client.focusTask(this.task.id);
    return { root, focus: this.composer };
  }

  destroy(): void {
    this.approvalOverlay?.hide();
    this.loader.stop();
    this.app.client.focusTask(null);
  }

  async loadHistory(): Promise<void> {
    try {
      const history = await this.app.client.getTaskHistory(this.task.id);
      if (this.app.currentScreenId !== this.id) return;
      this.transcript.replaceAll(history.items);
      this.setStatus(history.status);
      this.app.tui.requestRender();
    } catch (error) {
      this.app.statusNote = `history failed: ${String(error)}`;
      this.app.refreshHeader();
      this.app.tui.requestRender();
    }
  }

  onEvent(event: TaskEvent): void {
    if (event.taskId !== this.task.id) return;
    switch (event.type) {
      case "item.append":
        this.transcript.append(event.item);
        break;
      case "item.update":
        this.transcript.update(event.item);
        if (event.item.kind === "approval" && event.item.answered) {
          this.approvalOverlay?.hide();
        }
        break;
      case "status":
        this.setStatus(event.status);
        break;
      case "history.replaced":
        this.transcript.replaceAll(event.items);
        break;
    }
    this.app.tui.requestRender();
  }

  handleKey(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      if (this.app.tui.hasOverlay()) {
        this.approvalOverlay?.hide();
        return true;
      }
      this.app.show(new TaskListScreen(this.app));
      return true;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.taskStatus === "running" || this.taskStatus === "waiting") {
        void this.app.client.stopTask(this.task.id).catch((error) => {
          this.app.statusNote = `stop failed: ${String(error)}`;
        });
      } else {
        this.app.show(new TaskListScreen(this.app));
      }
      return true;
    }
    if (matchesKey(data, "a") && this.composer.getText() === "") {
      const pending = this.transcript.pendingApproval();
      if (pending) {
        this.openApproval(pending.item, pending.view);
        return true;
      }
    }
    return false;
  }

  private async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.composer.setText("");
    try {
      await this.app.client.sendMessage(this.task.id, trimmed);
    } catch (error) {
      this.app.statusNote = `send failed: ${String(error)}`;
      this.app.tui.requestRender();
    }
  }

  private setStatus(status: TaskSummary["status"]): void {
    this.taskStatus = status;
    this.titleBar.setText(this.titleText());
    this.setRunningUi(status === "running");
  }

  private setRunningUi(running: boolean): void {
    this.running = running;
    if (running) this.loader.start();
    else this.loader.stop();
  }

  private titleText(): string {
    const project = this.app.projects.find((entry) => entry.id === this.task.projectId);
    return (
      t(` ${this.task.title || "(untitled)"} `, colors.text, { bold: true }) +
      t(` ${project?.name ?? "?"} · ${this.task.provider} · ${statusText[this.taskStatus]}`, colors.muted)
    );
  }

  private openApproval(
    item: ConversationItem & { kind: "approval" },
    view: ApprovalItem,
  ): void {
    const options = item.options;
    if (options.length === 0) {
      this.openFreeformApproval(item, view);
      return;
    }
    const items: SelectItem[] = options.map((option) => ({
      value: option.id,
      label: option.label,
    }));
    const list = new SelectList(items, Math.min(8, items.length + 2), selectListTheme);
    list.onSelect = (selected) => {
      this.approvalOverlay?.hide();
      view.resolve(options.find((option) => option.id === selected.value)?.label ?? selected.value);
      void this.app.client
        .answerItem(this.task.id, item.id, selected.value)
        .catch((error) => {
          this.app.statusNote = `answer failed: ${String(error)}`;
        });
    };
    list.onCancel = () => this.approvalOverlay?.hide();
    // The overlay root must be the interactive component: focus is given to the
    // overlay component itself, a wrapper container would swallow the keystrokes.
    this.approvalOverlay = this.app.tui.showOverlay(list, {
      width: "60%",
      anchor: "center",
    });
    this.app.tui.requestRender();
  }

  private openFreeformApproval(
    item: ConversationItem & { kind: "approval" },
    view: ApprovalItem,
  ): void {
    const editor = new Editor(this.app.tui, { borderColor: editorBorder, selectList: selectListTheme });
    editor.onSubmit = (text) => {
      this.approvalOverlay?.hide();
      view.resolve(text);
      void this.app.client
        .answerItem(this.task.id, item.id, text)
        .catch((error) => {
          this.app.statusNote = `answer failed: ${String(error)}`;
        });
    };
    this.approvalOverlay = this.app.tui.showOverlay(editor, { width: "60%", anchor: "center" });
    this.app.tui.requestRender();
  }
}

/** Transcript container keyed by item id; updates never rewrite history. */
class TranscriptView extends Container {
  private readonly entries = new Map<string, { item: ConversationItem; view: Component }>();

  replaceAll(items: ConversationItem[]): void {
    this.clear();
    this.entries.clear();
    for (const item of items) this.append(item);
  }

  append(item: ConversationItem): void {
    if (this.entries.has(item.id)) return this.update(item);
    const view = createItemView(item);
    this.entries.set(item.id, { item, view });
    this.addChild(view);
  }

  update(item: ConversationItem): void {
    const entry = this.entries.get(item.id);
    if (!entry) return this.append(item);
    entry.item = item;
    switch (item.kind) {
      case "user":
        if (entry.view instanceof UserItem) entry.view.setText(item.text);
        break;
      case "assistant":
        if (entry.view instanceof AssistantItem) entry.view.setText(item.text);
        break;
      case "tool":
        if (entry.view instanceof ToolItem) entry.view.setUpdate(item.name, item.detail, item.state);
        break;
      case "approval":
        if (entry.view instanceof ApprovalItem && item.answered)
          entry.view.resolve(item.answered);
        break;
      case "system":
        if (entry.view instanceof SystemItem) entry.view.setText(item.text);
        break;
    }
    entry.view.invalidate();
  }

  viewFor(id: string): Component | undefined {
    return this.entries.get(id)?.view;
  }

  pendingApproval(): { item: ConversationItem & { kind: "approval" }; view: ApprovalItem } | null {
    for (const entry of this.entries.values()) {
      if (entry.item.kind === "approval" && !entry.item.answered) {
        return { item: entry.item, view: entry.view as ApprovalItem };
      }
    }
    return null;
  }
}

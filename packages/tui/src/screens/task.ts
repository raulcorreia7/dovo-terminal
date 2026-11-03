import { assertNever } from "@dovo-terminal/protocol/errors.ts";
import type { TaskEvent } from "@dovo-terminal/protocol/sync.ts";
import type { ConversationItem, TaskSummary } from "@dovo-terminal/protocol/workspace.ts";
import {
  type Component,
  Editor,
  Key,
  Loader,
  matchesKey,
  type OverlayHandle,
  ScrollView,
  type SelectItem,
  SelectList,
  VStack,
} from "@earendil-works/pi-tui";
import type { App } from "../app.ts";
import type { ApprovalItem } from "../items.ts";
import { LineText } from "../line.ts";
import type { Screen } from "../screen.ts";
import { statusLabel } from "../status.ts";
import { colors, editorBorder, selectListTheme, t } from "../theme/index.ts";
import { TranscriptView } from "../transcript.ts";

export class TaskScreen implements Screen {
  readonly id = "task";
  private readonly transcript = new TranscriptView();
  private readonly scroll: ScrollView;
  private readonly titleBar: LineText;
  private readonly composer: Editor;
  private readonly loader: Loader;
  private taskStatus: TaskSummary["status"];
  private approvalOverlay: OverlayHandle | null = null;

  private readonly app: App;
  private readonly task: TaskSummary;

  constructor(app: App, task: TaskSummary) {
    this.app = app;
    this.task = task;
    this.taskStatus = task.status;
    this.titleBar = new LineText(this.titleText());
    this.scroll = new ScrollView(this.transcript, {
      follow: "end",
      primary: true,
      scrollbar: "auto",
    });
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
    this.setStatus(task.status);
  }

  recreate(): Screen {
    return new TaskScreen(this.app, this.task);
  }

  build(): { root: VStack; focus?: Component } {
    const root = new VStack();
    root.addChild(this.titleBar, { basis: "auto" });
    root.addChild(this.scroll, { grow: 1, basis: 0 });
    root.addChild(this.loader, { basis: "auto", visible: () => this.taskStatus === "running" });
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
      if (this.app.currentScreenId !== this.id) {
        return;
      }
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
    if (event.taskId !== this.task.id) {
      return;
    }
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
      default:
        assertNever(event);
    }
    this.app.tui.requestRender();
  }

  handleKey(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      if (this.app.tui.hasOverlay()) {
        this.approvalOverlay?.hide();
        return true;
      }
      void import("./tasklist.ts").then(({ TaskListScreen }) =>
        this.app.show(new TaskListScreen(this.app)),
      );
      return true;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.taskStatus === "running" || this.taskStatus === "waiting") {
        void this.app.client.stopTask(this.task.id).catch((error) => {
          this.app.statusNote = `stop failed: ${String(error)}`;
        });
      } else {
        void import("./tasklist.ts").then(({ TaskListScreen }) =>
          this.app.show(new TaskListScreen(this.app)),
        );
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
    if (!trimmed) {
      return;
    }
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
    if (status === "running") {
      this.loader.start();
    } else {
      this.loader.stop();
    }
  }

  private titleText(): string {
    const project = this.app.projects.find((entry) => entry.id === this.task.projectId);
    return (
      t(` ${this.task.title || "(untitled)"} `, colors.text, { bold: true }) +
      t(
        ` ${project?.name ?? "?"} · ${this.task.provider} · ${statusLabel(this.taskStatus)}`,
        colors.muted,
      )
    );
  }

  private openApproval(item: ConversationItem & { kind: "approval" }, view: ApprovalItem): void {
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
      void this.app.client.answerItem(this.task.id, item.id, selected.value).catch((error) => {
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
    const editor = new Editor(this.app.tui, {
      borderColor: editorBorder,
      selectList: selectListTheme,
    });
    editor.onSubmit = (text) => {
      this.approvalOverlay?.hide();
      view.resolve(text);
      void this.app.client.answerItem(this.task.id, item.id, text).catch((error) => {
        this.app.statusNote = `answer failed: ${String(error)}`;
      });
    };
    this.approvalOverlay = this.app.tui.showOverlay(editor, { width: "60%", anchor: "center" });
    this.app.tui.requestRender();
  }
}

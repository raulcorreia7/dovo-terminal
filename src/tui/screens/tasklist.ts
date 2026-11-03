import {
  type Component,
  Editor,
  Key,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  VStack,
} from "@earendil-works/pi-tui";
import { errorMessage } from "dovo-terminal/protocol/errors.ts";
import type { TaskStatus } from "dovo-terminal/protocol/workspace.ts";
import { type App, note } from "dovo-terminal/tui/app.ts";
import { ConfirmPrompt } from "dovo-terminal/tui/confirm.ts";
import type { Screen } from "dovo-terminal/tui/screen.ts";
import { colors, editorBorder, selectListTheme, t } from "dovo-terminal/tui/theme.ts";

const statusGlyph: Record<TaskStatus, string> = {
  running: t("●", colors.ok),
  waiting: t("●", colors.warn),
  idle: t("○", colors.muted),
  error: t("✗", colors.error),
  unknown: t("?", colors.dim),
};

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)}h`;
  }
  return `${Math.floor(s / 86_400)}d`;
}

export class TaskListScreen implements Screen {
  readonly id = "tasks";
  private readonly app: App;
  private root = new VStack();
  private filter: Editor;
  private list: SelectList | null = null;
  private filterFocused: boolean = false;
  private confirmOverlay: OverlayHandle | null = null;

  constructor(app: App) {
    this.app = app;
    this.filter = new Editor(this.app.tui, {
      borderColor: editorBorder,
      selectList: selectListTheme,
    });
    this.filter.onSubmit = () => this.app.tui.setFocus(this.list);
    this.filter.onChange = (text) => this.list?.setFilter(text.trim());
  }

  build(): { root: VStack; focus?: Component | undefined } {
    this.rebuildList();
    const { focus } = this.compose();
    return { root: this.root, focus };
  }

  onTasksUpdated(): void {
    this.rebuildList();
    const { focus } = this.compose();
    this.list?.setFilter(this.filter.getText().trim());
    if (!this.filterFocused && focus) {
      this.app.tui.setFocus(focus);
    }
    this.app.tui.requestRender();
  }

  /** pi-tui's built-in empty-list text says "commands"; tasks need their own. */
  private compose(): { focus?: Component | undefined } {
    // The App keeps THIS VStack instance; mutate it, never replace it.
    this.root.clear();
    this.root.addChild(this.filter, { basis: "auto" });
    if (this.app.tasks.length === 0) {
      const empty = note(this.emptyHint(), colors.dim);
      this.root.addChild(empty, { grow: 1, basis: 0 });
      return { focus: empty };
    }
    const list = this.list;
    if (!list) {
      // A refresh owns list construction; before the first one there is nothing to show.
      const empty = note(this.emptyHint(), colors.dim);
      this.root.addChild(empty, { grow: 1, basis: 0 });
      return { focus: empty };
    }
    this.root.addChild(list, { grow: 1, basis: 0 });
    return { focus: list };
  }

  private emptyHint(): string {
    if (this.app.online) {
      return "no tasks yet. press n to create one";
    }
    return "not connected to a runtime. press r to retry";
  }

  onConnection(): void {
    const { focus } = this.compose();
    if (focus && !this.filterFocused) {
      this.app.tui.setFocus(focus);
    }
  }

  handleKey(data: string): boolean {
    if (!this.filterFocused && matchesKey(data, "n")) {
      // Dynamic import: static ones would cycle, screens navigate back here.
      void import("dovo-terminal/tui/screens/newtask.ts").then(({ NewTaskScreen }) =>
        this.app.show(new NewTaskScreen(this.app)),
      );
      return true;
    }
    if (!this.filterFocused && matchesKey(data, "r")) {
      void this.app.refresh();
      return true;
    }
    if (!this.filterFocused && matchesKey(data, "/")) {
      this.filterFocused = true;
      this.app.tui.setFocus(this.filter);
      return true;
    }
    if (!this.filterFocused && matchesKey(data, Key.question)) {
      this.app.showHelp();
      return true;
    }
    if (!this.filterFocused && (matchesKey(data, "d") || matchesKey(data, Key.shift("d")))) {
      this.confirmRemove(matchesKey(data, Key.shift("d")));
      return true;
    }
    if (this.filterFocused && matchesKey(data, Key.escape)) {
      this.filterFocused = false;
      this.filter.setText("");
      this.list?.setFilter("");
      this.app.tui.setFocus(this.list);
      return true;
    }
    return false;
  }

  /** Removal is destructive, so it asks first; the overlay swallows every key. */
  private confirmRemove(permanently: boolean): void {
    const selected = this.list?.getSelectedItem();
    const task = this.app.tasks.find((entry) => entry.id === selected?.value);
    if (!task || this.confirmOverlay) {
      return;
    }
    const view = new ConfirmPrompt(task.title, permanently);
    view.onAnswer = (accept) => {
      this.confirmOverlay?.hide();
      this.confirmOverlay = null;
      this.app.tui.requestRender();
      if (accept) {
        void this.removeSelected(permanently);
      }
    };
    this.confirmOverlay = this.app.tui.showOverlay(view, { width: "70%", anchor: "center" });
    this.app.tui.requestRender();
  }

  private async removeSelected(permanently: boolean): Promise<void> {
    const selected = this.list?.getSelectedItem();
    const task = this.app.tasks.find((entry) => entry.id === selected?.value);
    if (!task) {
      return;
    }
    try {
      if (permanently) {
        await this.app.client.deleteTask(task.id);
      } else {
        await this.app.client.setTaskArchived(task.id, true);
      }
      await this.app.refresh();
    } catch (error) {
      let verb = "archive";
      if (permanently) {
        verb = "delete";
      }
      this.app.statusNote = `${verb} failed: ${errorMessage(error)}`;
      this.app.refreshHeader();
      this.app.tui.requestRender();
    }
  }

  private rebuildList(): void {
    const projectName = new Map(this.app.projects.map((p) => [p.id, p.name]));
    const tasks = [...this.app.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
    const items: SelectItem[] = tasks.map((task) => ({
      value: task.id,
      label: `${statusGlyph[task.status]} ${task.title || "(untitled task)"}`,
      description: `${projectName.get(task.projectId) ?? "?"} · ${task.provider} · ${relativeTime(task.updatedAt)} ago`,
    }));
    this.list = new SelectList(items, Math.max(5, this.app.tui.terminal.rows - 6), selectListTheme);
    this.list.onSelect = (item) => {
      const task = tasks.find((entry) => entry.id === item.value);
      if (task) {
        void import("dovo-terminal/tui/screens/task.ts").then(({ TaskScreen }) =>
          this.app.show(new TaskScreen(this.app, task)),
        );
      }
    };
    this.list.onCancel = () => this.app.quit();
  }
}

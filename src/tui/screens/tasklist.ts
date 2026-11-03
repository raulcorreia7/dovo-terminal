import {
  Editor,
  Key,
  matchesKey,
  SelectList,
  VStack,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { TaskStatus } from "#protocol/workspace.ts";
import { note, type App } from "../app.ts";
import type { Screen } from "../screen.ts";
import { colors, editorBorder, selectListTheme, t } from "../theme.ts";
import { NewTaskScreen } from "./newtask.ts";
import { TaskScreen } from "./task.ts";

const statusGlyph: Record<TaskStatus, string> = {
  running: t("●", colors.ok),
  waiting: t("●", colors.warn),
  idle: t("○", colors.muted),
  error: t("✗", colors.error),
  unknown: t("?", colors.dim),
};

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export class TaskListScreen implements Screen {
  readonly id = "tasks";
  private readonly app: App;
  private root = new VStack();
  private filter: Editor;
  private list: SelectList | null = null;
  private filterFocused = false;

  constructor(app: App) {
    this.app = app;
    this.filter = new Editor(this.app.tui, {
      borderColor: editorBorder,
      selectList: selectListTheme,
    });
    this.filter.onSubmit = () => this.app.tui.setFocus(this.list);
    this.filter.onChange = (text) => this.list?.setFilter(text.trim());
  }

  build(): { root: VStack; focus?: Component } {
    this.rebuildList();
    const { focus } = this.compose();
    return { root: this.root, focus };
  }

  onTasksUpdated(): void {
    this.rebuildList();
    const { focus } = this.compose();
    this.list?.setFilter(this.filter.getText().trim());
    if (!this.filterFocused && focus) this.app.tui.setFocus(focus);
    this.app.tui.requestRender();
  }

  /** pi-tui's built-in empty-list text says "commands"; tasks need their own. */
  private compose(): { focus?: Component } {
    // The App keeps THIS VStack instance; mutate it, never replace it.
    this.root.clear();
    this.root.addChild(this.filter, { basis: "auto" });
    if (this.app.tasks.length === 0) {
      const hint = this.app.connected
        ? "no tasks yet. press n to create one"
        : "not connected to a runtime. press r to retry";
      const empty = note(hint, colors.dim);
      this.root.addChild(empty, { grow: 1, basis: 0 });
      return { focus: empty };
    }
    this.root.addChild(this.list!, { grow: 1, basis: 0 });
    return { focus: this.list! };
  }

  onConnection(): void {
    const { focus } = this.compose();
    if (focus && !this.filterFocused) this.app.tui.setFocus(focus);
  }

  handleKey(data: string): boolean {
    if (!this.filterFocused && matchesKey(data, "n")) {
      this.app.show(new NewTaskScreen(this.app));
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
      void this.removeSelected(matchesKey(data, Key.shift("d")));
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

  private async removeSelected(permanently: boolean): Promise<void> {
    const selected = this.list?.getSelectedItem();
    const task = this.app.tasks.find((entry) => entry.id === selected?.value);
    if (!task) return;
    try {
      if (permanently) await this.app.client.deleteTask(task.id);
      else await this.app.client.setTaskArchived(task.id, true);
      await this.app.refresh();
    } catch (error) {
      this.app.statusNote = `${permanently ? "delete" : "archive"} failed: ${String(error)}`;
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
      if (task) this.app.show(new TaskScreen(this.app, task));
    };
    this.list.onCancel = () => this.app.quit();
  }
}

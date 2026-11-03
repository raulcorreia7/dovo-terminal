import type { Project } from "@dovo-terminal/protocol/workspace.ts";
import {
  type Component,
  Editor,
  Key,
  matchesKey,
  SelectList,
  VStack,
} from "@earendil-works/pi-tui";
import { type App, note } from "../app.ts";
import { type ListAction, pressed } from "../keys.ts";
import { PortOverlay } from "../port-overlay.ts";
import type { Screen } from "../screen.ts";
import { toSelectItem } from "../task-items.ts";
import { TaskRemoval } from "../task-removal.ts";
import { buildRows, PROJECT_PREFIX, rowKey, type TreeRow } from "../task-rows.ts";
import { colors, editorBorder, selectListTheme } from "../theme/index.ts";

export class TaskListScreen implements Screen {
  readonly id = "tasks";
  private readonly app: App;
  private root = new VStack();
  private filter: Editor;
  private list: SelectList | null = null;
  private rows: TreeRow[] = [];
  private query: string = "";
  private filterFocused: boolean = false;
  private readonly removal: TaskRemoval;
  private readonly ports: PortOverlay;

  constructor(app: App) {
    this.app = app;
    this.removal = new TaskRemoval(app);
    this.ports = new PortOverlay(app);
    this.filter = new Editor(this.app.tui, {
      borderColor: editorBorder,
      selectList: selectListTheme,
    });
    this.filter.onSubmit = () => this.app.tui.setFocus(this.list);
    this.filter.onChange = (text) => {
      this.query = text.trim();
      this.reshape();
    };
  }

  recreate(): Screen {
    return new TaskListScreen(this.app);
  }

  build(): { root: VStack; focus?: Component | undefined } {
    this.rebuildList();
    const { focus } = this.compose();
    return { root: this.root, focus };
  }

  onTasksUpdated(): void {
    this.reshape();
  }

  /** Rebuild rows and list, keep the selection on the same row, and redraw. */
  private reshape(prefer?: string): void {
    this.rebuildList(prefer);
    this.refocus(this.compose().focus);
    this.app.tui.requestRender();
  }

  /** pi-tui's built-in empty-list text says "commands"; tasks need their own. */
  private compose(): { focus?: Component | undefined } {
    // The App keeps THIS VStack instance; mutate it, never replace it.
    this.root.clear();
    this.root.addChild(this.filter, { basis: "auto" });
    if (this.rows.length === 0) {
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
    if (this.query) {
      return `no task matches "${this.query}"`;
    }
    if (this.app.online) {
      return "no tasks yet. press n to create one";
    }
    return "not connected to a runtime. press r to retry";
  }

  onConnection(): void {
    this.refocus(this.compose().focus);
  }

  /** Give the list focus after a rebuild, unless the filter or an overlay holds the keyboard. */
  private refocus(focus: Component | undefined): void {
    if (focus && !this.filterFocused && !this.app.tui.hasOverlay()) {
      this.app.tui.setFocus(focus);
    }
  }

  handleKey(data: string): boolean {
    if (this.filterFocused) {
      return this.handleFilterKey(data);
    }
    if (this.app.tui.hasOverlay()) {
      return false; // the overlay on top owns the keys
    }

    return this.handleListKey(data);
  }

  /** What each action does while the list has focus; first match wins (delete before archive). */
  private listActions(): [ListAction, () => void][] {
    return [
      ["new", () => this.openNewTask()],
      ["refresh", () => void this.app.refresh()],
      ["theme", () => this.app.showThemePicker()],
      ["invite", () => this.openInvite()],
      ["shell", () => this.openShell()],
      ["open", () => void this.ports.open(this.selectedProject()?.id)],
      ["machines", () => this.openMachines()],
      ["unfold", () => this.expandSelected()],
      ["fold", () => this.collapseSelected()],
      ["search", () => this.focusFilter()],
      ["help", () => this.app.showHelp()],
      ["delete", () => this.confirmRemove(true)],
      ["archive", () => this.confirmRemove(false)],
    ];
  }

  private handleListKey(data: string): boolean {
    const binding = this.listActions().find(([action]) => pressed(data, action, this.app.keys));
    if (!binding) {
      return false;
    }

    binding[1]();

    return true;
  }

  private handleFilterKey(data: string): boolean {
    if (!matchesKey(data, Key.escape)) {
      return false;
    }

    this.filterFocused = false;
    this.filter.setText("");
    this.query = "";
    this.reshape();
    this.app.tui.setFocus(this.list);

    return true;
  }

  private focusFilter(): void {
    this.filterFocused = true;
    this.app.tui.setFocus(this.filter);
  }

  /** The project under the cursor: the project row itself, or the project of a task row. */
  private selectedProject(): Project | undefined {
    const row = this.selectedRow();
    const projectId = row?.kind === "project" ? row.project.id : row?.task.projectId;

    return this.app.projects.find((project) => project.id === projectId);
  }

  private openShell(): void {
    this.app.openShell(this.selectedProject());
  }

  private openMachines(): void {
    void import("./machines.ts").then(({ MachinesScreen }) =>
      this.app.show(new MachinesScreen(this.app)),
    );
  }

  private openInvite(): void {
    void import("./devices.ts").then(({ DevicesScreen }) =>
      this.app.show(new DevicesScreen(this.app)),
    );
  }

  private openNewTask(): void {
    // Dynamic import: static ones would cycle, screens navigate back here.
    void import("./newtask.ts").then(({ NewTaskScreen }) =>
      this.app.show(new NewTaskScreen(this.app)),
    );
  }

  private rowFor(value: string | undefined): TreeRow | undefined {
    return this.rows.find((row) => rowKey(row) === value);
  }

  private selectedRow(): TreeRow | undefined {
    return this.rowFor(this.list?.getSelectedItem()?.value);
  }

  /** Enter on a project folds or unfolds it; on a task it opens the thread. */
  private activate(value: string): void {
    const row = this.rowFor(value);
    if (row?.kind === "project") {
      this.setCollapsed(row.project.id, !row.collapsed, value);
    } else if (row) {
      void import("./task.ts").then(({ TaskScreen }) =>
        this.app.show(new TaskScreen(this.app, row.task)),
      );
    }
  }

  private setCollapsed(projectId: string, collapsed: boolean, select: string): void {
    if (collapsed) {
      this.app.collapsedProjects.add(projectId);
    } else {
      this.app.collapsedProjects.delete(projectId);
    }
    this.reshape(select);
  }

  /** Right: unfold the selected project. */
  private expandSelected(): void {
    const row = this.selectedRow();
    if (row?.kind === "project" && row.collapsed) {
      this.setCollapsed(row.project.id, false, rowKey(row));
    }
  }

  /** Left: fold the selected project, or the project of the selected task. */
  private collapseSelected(): void {
    const row = this.selectedRow();
    if (row?.kind === "project" && !row.collapsed) {
      this.setCollapsed(row.project.id, true, rowKey(row));
    } else if (row?.kind === "task" && !this.query) {
      this.setCollapsed(row.task.projectId, true, PROJECT_PREFIX + row.task.projectId);
    }
  }

  private confirmRemove(permanently: boolean): void {
    const selected = this.list?.getSelectedItem();
    this.removal.ask(
      this.app.tasks.find((entry) => entry.id === selected?.value),
      permanently,
    );
  }

  private rebuildList(prefer?: string): void {
    const previous = prefer ?? this.list?.getSelectedItem()?.value;
    this.rows = buildRows(this.app.projects, this.app.tasks, {
      collapsed: this.app.collapsedProjects,
      query: this.query,
      notes: this.app.projectNotes,
    });
    const items = this.rows.map((row) => toSelectItem(row, this.query !== ""));
    const list = new SelectList(
      items,
      Math.max(5, this.app.tui.terminal.rows - 6),
      selectListTheme,
    );
    list.setSelectedIndex(
      Math.max(
        0,
        items.findIndex((item) => item.value === previous),
      ),
    );
    list.onSelect = (item) => this.activate(item.value);
    list.onCancel = () => this.app.quit();
    this.list = list;
  }
}

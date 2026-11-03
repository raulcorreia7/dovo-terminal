import {
  type Component,
  Editor,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  VStack,
} from "@earendil-works/pi-tui";
import type { App } from "dovo-terminal/tui/app.ts";
import { LineText } from "dovo-terminal/tui/line.ts";
import type { Screen } from "dovo-terminal/tui/screen.ts";
import { colors, editorBorder, selectListTheme, t } from "dovo-terminal/tui/theme.ts";

export type NewTaskStep =
  | { kind: "project" }
  | { kind: "provider"; projectId: string }
  | { kind: "prompt"; projectId: string; providerId: string };

/**
 * Each step is shown by re-entering this screen with the next step: the step
 * change replaces the layout root, which is also how pi-tui hands focus to the
 * new body. Mutating children in place leaves focus on the captured component.
 */
export class NewTaskScreen implements Screen {
  readonly id = "new-task";
  private readonly app: App;
  private readonly step: NewTaskStep;

  constructor(app: App, step: NewTaskStep = { kind: "project" }) {
    this.app = app;
    this.step = step;
  }

  build(): { root: VStack; focus?: Component } {
    const root = new VStack();
    const heading = new LineText(this.headingText());
    root.addChild(heading, { basis: "auto" });
    const { body, focus } = this.renderStep();
    root.addChild(body, { grow: 1, basis: 0 });
    return { root, focus };
  }

  handleKey(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      this.back();
      return true;
    }
    return false;
  }

  private back(): void {
    if (this.step.kind === "prompt") {
      this.app.show(
        new NewTaskScreen(this.app, { kind: "provider", projectId: this.step.projectId }),
      );
    } else if (this.step.kind === "provider") {
      this.app.show(new NewTaskScreen(this.app, { kind: "project" }));
    } else {
      void import("dovo-terminal/tui/screens/tasklist.ts").then(({ TaskListScreen }) =>
        this.app.show(new TaskListScreen(this.app)),
      );
    }
  }

  private headingText(): string {
    if (this.step.kind === "project") {
      return t("New task — choose project", colors.accent, { bold: true });
    }
    if (this.step.kind === "provider") {
      return t("New task — choose agent", colors.accent, { bold: true });
    }
    return t("New task — describe the work (enter to start)", colors.accent, { bold: true });
  }

  private renderStep(): { body: Component; focus: Component } {
    if (this.step.kind === "project") {
      const items: SelectItem[] = this.app.projects.map((project) => ({
        value: project.id,
        label: project.name,
        description: project.path,
      }));
      const list = new SelectList(items, this.listHeight(), selectListTheme);
      list.onSelect = (item) =>
        this.app.show(new NewTaskScreen(this.app, { kind: "provider", projectId: item.value }));
      list.onCancel = () =>
        void import("dovo-terminal/tui/screens/tasklist.ts").then(({ TaskListScreen }) =>
          this.app.show(new TaskListScreen(this.app)),
        );
      return { body: list, focus: list };
    }
    if (this.step.kind === "provider") {
      const projectId = this.step.projectId;
      const items: SelectItem[] = this.app.providers.map((provider) => ({
        value: provider.id,
        label: provider.label,
      }));
      const list = new SelectList(items, this.listHeight(), selectListTheme);
      list.onSelect = (item) =>
        this.app.show(
          new NewTaskScreen(this.app, {
            kind: "prompt",
            projectId,
            providerId: item.value,
          }),
        );
      list.onCancel = () => this.app.show(new NewTaskScreen(this.app, { kind: "project" }));
      return { body: list, focus: list };
    }
    const projectId = this.step.projectId;
    const providerId = this.step.providerId;
    const editor = new Editor(this.app.tui, {
      borderColor: editorBorder,
      selectList: selectListTheme,
    });
    editor.onSubmit = (text) => void this.create(projectId, providerId, text);
    return { body: editor, focus: editor };
  }

  private async create(projectId: string, providerId: string, prompt: string): Promise<void> {
    if (!prompt.trim()) {
      return;
    }
    try {
      const task = await this.app.client.createTask({
        projectId,
        providerId,
        prompt: prompt.trim(),
      });
      void import("dovo-terminal/tui/screens/task.ts").then(({ TaskScreen }) =>
        this.app.show(new TaskScreen(this.app, task)),
      );
    } catch (error) {
      this.app.statusNote = `create failed: ${String(error)}`;
      this.app.tui.requestRender();
    }
  }

  private listHeight(): number {
    return Math.max(5, this.app.tui.terminal.rows - 6);
  }
}

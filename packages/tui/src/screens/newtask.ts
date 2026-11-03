import type { ModelOption } from "@dovo-terminal/protocol/workspace.ts";
import {
  type Component,
  Editor,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  VStack,
} from "@earendil-works/pi-tui";
import type { App } from "../app.ts";
import { LineText } from "../line.ts";
import type { Screen } from "../screen.ts";
import { colors, editorBorder, selectListTheme, t } from "../theme/index.ts";

export type NewTaskStep =
  | { kind: "project" }
  | { kind: "provider"; projectId: string }
  | { kind: "model"; projectId: string; providerId: string; models: ModelOption[] }
  | {
      kind: "prompt";
      projectId: string;
      providerId: string;
      /** The model id chosen; empty means the harness's default. */
      model: string;
      /** The catalog the model step offered, so back can return to it. Empty if none was shown. */
      models: ModelOption[];
    };

/** A catalog this short is no choice: skip the step. */
const MIN_MODELS_TO_ASK = 2;

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

  recreate(): Screen {
    return new NewTaskScreen(this.app, this.step);
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
    if (this.step.kind === "prompt" && this.step.models.length > 0) {
      const { projectId, providerId, models } = this.step;
      this.app.show(new NewTaskScreen(this.app, { kind: "model", projectId, providerId, models }));
    } else if (this.step.kind === "prompt" || this.step.kind === "model") {
      this.app.show(
        new NewTaskScreen(this.app, { kind: "provider", projectId: this.step.projectId }),
      );
    } else if (this.step.kind === "provider") {
      this.app.show(new NewTaskScreen(this.app, { kind: "project" }));
    } else {
      void import("./tasklist.ts").then(({ TaskListScreen }) =>
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
    if (this.step.kind === "model") {
      return t("New task — choose model", colors.accent, { bold: true });
    }
    const choice = [this.providerLabel(this.step.providerId), this.modelLabel(this.step)]
      .filter(Boolean)
      .join(" · ");

    return (
      t("New task — describe the work (enter to start)", colors.accent, { bold: true }) +
      t(`  ${choice}`, colors.muted)
    );
  }

  private providerLabel(providerId: string): string {
    return this.app.providers.find((provider) => provider.id === providerId)?.label ?? providerId;
  }

  private modelLabel(step: { model: string; models: ModelOption[] }): string {
    return step.models.find((model) => model.id === step.model)?.label ?? step.model;
  }

  /** Ask for a model only when the harness offers a real choice; otherwise go straight to the prompt. */
  private async chooseProvider(projectId: string, providerId: string): Promise<void> {
    const models = await this.app.client.listModels(providerId).catch(() => []);
    if (models.length >= MIN_MODELS_TO_ASK) {
      this.app.show(new NewTaskScreen(this.app, { kind: "model", projectId, providerId, models }));
    } else {
      this.app.show(
        new NewTaskScreen(this.app, {
          kind: "prompt",
          projectId,
          providerId,
          model: "",
          models: [],
        }),
      );
    }
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
        void import("./tasklist.ts").then(({ TaskListScreen }) =>
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
      list.onSelect = (item) => void this.chooseProvider(projectId, item.value);
      list.onCancel = () => this.app.show(new NewTaskScreen(this.app, { kind: "project" }));
      return { body: list, focus: list };
    }
    if (this.step.kind === "model") {
      return this.renderModelStep(this.step);
    }
    const { projectId, providerId, model } = this.step;
    const editor = new Editor(this.app.tui, {
      borderColor: editorBorder,
      selectList: selectListTheme,
    });
    editor.onSubmit = (text) => void this.create(projectId, providerId, model, text);
    return { body: editor, focus: editor };
  }

  private renderModelStep(step: { projectId: string; providerId: string; models: ModelOption[] }): {
    body: Component;
    focus: Component;
  } {
    const { projectId, providerId, models } = step;
    const items: SelectItem[] = [
      { value: "", label: "default", description: "the harness picks" },
      ...models.map((model) => ({ value: model.id, label: model.label, description: model.id })),
    ];
    const list = new SelectList(items, this.listHeight(), selectListTheme);
    list.onSelect = (item) =>
      this.app.show(
        new NewTaskScreen(this.app, {
          kind: "prompt",
          projectId,
          providerId,
          model: item.value,
          models,
        }),
      );
    list.onCancel = () =>
      this.app.show(new NewTaskScreen(this.app, { kind: "provider", projectId }));

    return { body: list, focus: list };
  }

  private async create(
    projectId: string,
    providerId: string,
    model: string,
    prompt: string,
  ): Promise<void> {
    if (!prompt.trim()) {
      return;
    }
    try {
      const task = await this.app.client.createTask({
        projectId,
        providerId,
        ...(model && { model }),
        prompt: prompt.trim(),
      });
      void import("./task.ts").then(({ TaskScreen }) =>
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

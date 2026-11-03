import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { TaskSummary } from "@dovo-terminal/protocol/workspace.ts";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { App } from "./app.ts";
import { ConfirmPrompt, removeHeadline } from "./confirm.ts";

/**
 * Archive or delete a task. Removal is destructive, so it asks first; the
 * confirmation overlay takes every key until it is answered.
 */
export class TaskRemoval {
  private readonly app: App;
  private overlay: OverlayHandle | null = null;

  constructor(app: App) {
    this.app = app;
  }

  ask(task: TaskSummary | undefined, permanently: boolean): void {
    if (!task || this.overlay) {
      return;
    }
    const prompt = new ConfirmPrompt(removeHeadline(task.title, permanently));
    prompt.onAnswer = (accept) => {
      this.overlay?.hide();
      this.overlay = null;
      this.app.tui.requestRender();
      if (accept) {
        void this.remove(task, permanently);
      }
    };
    this.overlay = this.app.tui.showOverlay(prompt, { width: "70%", anchor: "center" });
    this.app.tui.requestRender();
  }

  private async remove(task: TaskSummary, permanently: boolean): Promise<void> {
    try {
      if (permanently) {
        await this.app.client.deleteTask(task.id);
      } else {
        await this.app.client.setTaskArchived(task.id, true);
      }
      await this.app.refresh();
    } catch (error) {
      const verb = permanently ? "delete" : "archive";
      this.app.statusNote = `${verb} failed: ${errorMessage(error)}`;
      this.app.refreshHeader();
      this.app.tui.requestRender();
    }
  }
}

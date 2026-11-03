import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { ServicePort } from "@dovo-terminal/protocol/workspace.ts";
import { type OverlayHandle, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import type { App } from "./app.ts";
import { colors, selectListTheme, t } from "./theme/index.ts";

/** A picker for the web services a project is serving; choosing one opens it. */
export class PortOverlay {
  private readonly app: App;
  private overlay: OverlayHandle | null = null;

  constructor(app: App) {
    this.app = app;
  }

  async open(projectId: string | undefined): Promise<void> {
    if (this.overlay) {
      return;
    }
    try {
      const directory = this.app.client.ports;
      if (!directory) {
        this.say("this runtime cannot list running services");

        return;
      }
      const all = await directory.list();
      this.show(all.filter((port) => port.projectId === projectId));
    } catch (error) {
      this.app.statusNote = `services failed: ${errorMessage(error)}`;
      this.app.refreshHeader();
      this.app.tui.requestRender();
    }
  }

  private say(message: string): void {
    this.app.statusNote = message;
    this.app.refreshHeader();
    this.app.tui.requestRender();
  }

  private show(ports: ServicePort[]): void {
    if (ports.length === 0) {
      this.say("no web service is running for this project");

      return;
    }
    const items: SelectItem[] = ports.map((port) => ({
      value: String(port.pid * 100_000 + port.port),
      label: `${t(`:${port.port}`, colors.accent, { bold: true })}  ${port.command}`,
      description: port.folder,
    }));
    const list = new SelectList(items, Math.min(8, items.length + 1), selectListTheme);
    list.onSelect = (item) => {
      this.close();
      const chosen = ports.find((port) => String(port.pid * 100_000 + port.port) === item.value);
      if (chosen) {
        void this.openService(chosen);
      }
    };
    list.onCancel = () => this.close();
    this.overlay = this.app.tui.showOverlay(list, { width: "70%", anchor: "center" });
    this.app.tui.requestRender();
  }

  /** Open the chosen service and say what happened. */
  private async openService(port: ServicePort): Promise<void> {
    this.app.statusNote = this.app.openPort
      ? await this.app.openPort(port)
      : "opening services needs the local runtime server";
    this.app.refreshHeader();
    this.app.tui.requestRender();
  }

  private close(): void {
    this.overlay?.hide();
    this.overlay = null;
    this.app.tui.requestRender();
  }
}

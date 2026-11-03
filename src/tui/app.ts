import {
  Key,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type OverlayHandle,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { DovoClient } from "../api/client.ts";
import type {
  AgentProvider,
  Project,
  TaskEvent,
  TaskSummary,
} from "../api/types.ts";
import { HelpView } from "./help.ts";
import { LineText } from "./line.ts";
import { colors, t } from "./theme.ts";

export interface Screen {
  readonly id: string;
  /** Build the layout tree; called once when shown. */
  build(app: App): { root: VStack; focus?: Component };
  /** Global-ish keys before focus routing. Return true to consume. */
  handleKey?(data: string): boolean;
  onEvent?(event: TaskEvent): void;
  onTasksUpdated?(): void;
  onConnection?(connected: boolean): void;
  destroy?(): void;
}

export class App {
  readonly tui: TuiAltScreen;
  private screen: Screen | null = null;
  private header: LineText | null = null;
  private helpOverlay: OverlayHandle | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  projects: Project[] = [];
  tasks: TaskSummary[] = [];
  providers: AgentProvider[] = [];
  connected = false;
  statusNote = "";

  readonly client: DovoClient;

  constructor(client: DovoClient, terminal: Terminal = new ProcessTerminal()) {
    this.client = client;
    this.tui = new TuiAltScreen(terminal);
  }

  async start(initial: Screen): Promise<void> {
    this.client.onEvent = (event) => this.routeEvent(event);
    this.client.onSync = () => this.scheduleRefresh();
    this.client.onConnection = (connected) => {
      this.connected = connected;
      if (connected) this.scheduleRefresh();
      this.updateHeader();
      this.screen?.onConnection?.(connected);
      this.tui.requestRender();
    };
    this.tui.addInputListener((data) => this.onInput(data));

    let fatal: Error | null = null;
    try {
      await this.refresh();
    } catch (err) {
      // Unreachable runtime still opens the UI: the header shows it, retry is `r`.
      fatal = err instanceof Error ? err : new Error(String(err));
    }
    this.show(initial);
    if (fatal) this.statusNote = fatal.message;
    this.updateHeader();
    this.client.connect();
    this.tui.start();
  }

  quit(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    this.client.close();
    this.tui.stop();
    process.exit(0);
  }

  show(screen: Screen): void {
    this.screen?.destroy?.();
    this.screen = screen;
    const { root, focus } = screen.build(this);
    this.header = new LineText(this.headerText());
    const layout = new VStack();
    layout.addChild(this.header, { basis: "auto" });
    layout.addChild(root, { grow: 1, basis: 0 });
    this.tui.setLayoutRoot(layout);
    this.tui.setFocus(focus ?? root);
    this.tui.requestRender(true);
  }

  get currentScreenId(): string {
    return this.screen?.id ?? "";
  }

  async refresh(): Promise<void> {
    const [projects, tasks, providers] = await Promise.all([
      this.client.listProjects(),
      this.client.listTasks(),
      this.client.listProviders(),
    ]);
    this.projects = projects;
    this.tasks = tasks;
    this.providers = providers;
    this.screen?.onTasksUpdated?.();
    this.updateHeader();
    this.tui.requestRender();
  }

  /** Coalesce sync-triggered refreshes so a burst of frames is one round-trip. */
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(() => {});
    }, 250);
  }

  private routeEvent(event: TaskEvent): void {
    const task = this.tasks.find((entry) => entry.id === event.taskId);
    if (task && event.type === "status") {
      task.status = event.status;
      task.activeRunId = event.activeRunId ?? task.activeRunId;
    }
    this.screen?.onEvent?.(event);
    this.tui.requestRender();
  }

  private onInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, Key.ctrl("q"))) {
      this.quit();
      return { consume: true };
    }
    if (this.helpOverlay) {
      this.closeHelp();
      return { consume: true };
    }
    if (this.screen?.handleKey?.(data)) return { consume: true };
    return undefined;
  }

  // --- header ---------------------------------------------------------------

  private updateHeader(): void {
    this.header?.setText(this.headerText());
  }

  /** Screens may annotate the header (e.g. load failures) outside a refresh. */
  refreshHeader(): void {
    this.updateHeader();
  }

  // --- help overlay ----------------------------------------------------------

  showHelp(): void {
    if (this.helpOverlay) return;
    const view = new HelpView();
    view.onKey = () => this.closeHelp();
    this.helpOverlay = this.tui.showOverlay(view, { width: "60%", anchor: "center" });
    this.tui.requestRender();
  }

  closeHelp(): void {
    if (!this.helpOverlay) return;
    this.helpOverlay.hide();
    this.helpOverlay = null;
    this.tui.requestRender();
  }

  private headerText(): string {
    const dot = this.connected ? t("●", colors.ok) : t("●", colors.error);
    const counts = this.projects.length
      ? `${this.tasks.length} tasks · ${this.projects.length} projects`
      : "—";
    const note = this.statusNote ? ` · ${this.statusNote}` : "";
    const keys =
      this.screen?.id === "task"
        ? t(" esc back  ctrl+c stop", colors.dim)
        : t(" n new  r refresh  ? help  ctrl+q quit", colors.dim);
    return (
      t("dovo", colors.accent, { bold: true }) +
      ` ${dot}${note}` +
      t(`  ${counts}`, colors.muted) +
      keys
    );
  }
}

/** Plain multi-line message block, e.g. empty states and errors. */
export function note(text: string, color?: string): Text {
  return new Text(t(text, color), 1, 1);
}

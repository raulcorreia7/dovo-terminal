import {
  Key,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type Terminal,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import type { RuntimeClient } from "dovo-terminal/client/runtime-client.ts";
import { asError, assertNever } from "dovo-terminal/protocol/errors.ts";
import type {
  ConnectionPhase,
  SyncFrame,
  TaskEvent,
  Unsubscribe,
} from "dovo-terminal/protocol/sync.ts";
import type { AgentProvider, Project, TaskSummary } from "dovo-terminal/protocol/workspace.ts";
import { HelpView } from "dovo-terminal/tui/help.ts";
import { LineText } from "dovo-terminal/tui/line.ts";
import type { Screen } from "dovo-terminal/tui/screen.ts";
import { colors, t } from "dovo-terminal/tui/theme.ts";

export class App {
  readonly tui: TuiAltScreen;
  private screen: Screen | null = null;
  private header: LineText | null = null;
  private helpOverlay: OverlayHandle | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: Unsubscribe | null = null;
  private stopped: boolean = false;

  projects: Project[] = [];
  tasks: TaskSummary[] = [];
  providers: AgentProvider[] = [];
  phase: ConnectionPhase = "offline";
  statusNote: string = "";

  readonly client: RuntimeClient;

  constructor(client: RuntimeClient, terminal: Terminal = new ProcessTerminal()) {
    this.client = client;
    this.tui = new TuiAltScreen(terminal);
  }

  async start(initial: Screen): Promise<void> {
    this.unsubscribe = this.client.subscribe((frame) => this.onFrame(frame));
    this.tui.addInputListener((data) => this.onInput(data));

    let fatal: Error | null = null;
    try {
      await this.refresh();
    } catch (err) {
      // Unreachable runtime still opens the UI: the header shows it, retry is `r`.
      fatal = asError(err);
    }
    this.show(initial);
    if (fatal) {
      this.statusNote = fatal.message;
    }
    this.updateHeader();
    this.client.connect();
    this.tui.start();
  }

  /** One frame handler; each branch stays a single dispatch. */
  private onFrame(frame: SyncFrame): void {
    switch (frame.type) {
      case "event":
        this.routeEvent(frame.event);
        return;
      case "sync":
        this.scheduleRefresh();
        return;
      case "connection":
        this.phase = frame.state;
        if (frame.state === "online") {
          this.scheduleRefresh();
        }
        this.updateHeader();
        this.screen?.onConnection?.(frame.state);
        this.tui.requestRender();
        return;
      default:
        assertNever(frame);
    }
  }

  /** Derived from the single connection state; screens must not mirror it. */
  get online(): boolean {
    return this.phase === "online";
  }

  quit(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    this.unsubscribe?.();
    void this.client.close();
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
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(() => undefined);
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
    if (this.screen?.handleKey?.(data)) {
      return { consume: true };
    }
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
    if (this.helpOverlay) {
      return;
    }
    const view = new HelpView();
    view.onKey = () => this.closeHelp();
    this.helpOverlay = this.tui.showOverlay(view, { width: "60%", anchor: "center" });
    this.tui.requestRender();
  }

  closeHelp(): void {
    if (!this.helpOverlay) {
      return;
    }
    this.helpOverlay.hide();
    this.helpOverlay = null;
    this.tui.requestRender();
  }

  private headerText(): string {
    return (
      t("dovo", colors.accent, { bold: true }) +
      ` ${this.connectionDot()}${this.statusSuffix()}` +
      t(`  ${this.countsText()}`, colors.muted) +
      this.keysHint()
    );
  }

  private connectionDot(): string {
    if (this.phase === "online") {
      return t("●", colors.ok);
    }
    if (this.phase === "connecting" || this.phase === "reconnecting") {
      return t("●", colors.warn);
    }
    return t("●", colors.error);
  }

  private countsText(): string {
    if (this.projects.length === 0) {
      return "—";
    }
    return `${this.tasks.length} tasks · ${this.projects.length} projects`;
  }

  private statusSuffix(): string {
    if (!this.statusNote) {
      return "";
    }
    return ` · ${this.statusNote}`;
  }

  private keysHint(): string {
    if (this.screen?.id === "task") {
      return t(" esc back  ctrl+c stop", colors.dim);
    }
    return t(" n new  r refresh  ? help  ctrl+q quit", colors.dim);
  }
}

/** Plain multi-line message block, e.g. empty states and errors. */
export function note(text: string, color?: string): Text {
  return new Text(t(text, color), 1, 1);
}

import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import { type Component, Key, matchesKey, Text, VStack } from "@earendil-works/pi-tui";
import type { App } from "../app.ts";
import type { Check } from "../checks.ts";
import { LineText } from "../line.ts";
import type { Screen } from "../screen.ts";
import { colors, t } from "../theme/index.ts";

/** Group checks under their machine, a mark and a next step on each failure. */
export function reportLines(checks: readonly Check[]): string[] {
  const machines = [...new Set(checks.map((check) => check.machine))];

  return machines.flatMap((machine) => {
    const own = checks.filter((check) => check.machine === machine);
    const rows = own.flatMap((check) => {
      const mark = check.ok ? t("✓", colors.ok) : t("✗", colors.error);
      const line = `  ${mark} ${t(check.name.padEnd(9), colors.text)} ${t(check.detail, colors.muted)}`;

      return check.ok || !check.next
        ? [line]
        : [line, `      ${t(`→ ${check.next}`, colors.warn)}`];
    });

    return [t(machine, colors.accent, { bold: true }), ...rows, ""];
  });
}

/** Is everything working, on every machine? `r` checks again. */
export class MachinesScreen implements Screen {
  readonly id = "machines";
  private readonly app: App;
  private readonly root = new VStack();
  private checking: boolean = false;

  constructor(app: App) {
    this.app = app;
  }

  recreate(): Screen {
    return new MachinesScreen(this.app);
  }

  build(): { root: VStack; focus?: Component | undefined } {
    this.show([t("checking…", colors.dim)]);
    void this.check();

    return { root: this.root };
  }

  handleKey(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      void import("./tasklist.ts").then(({ TaskListScreen }) =>
        this.app.show(new TaskListScreen(this.app)),
      );

      return true;
    }
    if (matchesKey(data, "r")) {
      void this.check();

      return true;
    }

    return false;
  }

  private async check(): Promise<void> {
    if (this.checking) {
      return;
    }
    this.checking = true;
    try {
      const checks = (await this.app.checkMachines?.()) ?? [];
      this.show(checks.length > 0 ? reportLines(checks) : [t("nothing to check here", colors.dim)]);
    } catch (error) {
      this.show([t(`check failed: ${errorMessage(error)}`, colors.error)]);
    } finally {
      this.checking = false;
    }
  }

  private show(lines: string[]): void {
    this.root.clear();
    this.root.addChild(
      new LineText(
        t(" Machines", colors.accent, { bold: true }) +
          t("   r check again · esc back", colors.dim),
      ),
      { basis: "auto" },
    );
    this.root.addChild(new Text(lines.join("\n"), 1, 1), { grow: 1, basis: 0 });
    this.app.tui.requestRender();
  }
}

import type { OverlayHandle, TerminalColorScheme, TuiAltScreen } from "@earendil-works/pi-tui";
import { applyPalette, listThemes, resolveThemeId, schemeOfBackground } from "./index.ts";
import type { ThemeBook } from "./palette.ts";
import { AUTO_THEME, createThemePicker } from "./picker.ts";
import { DOVO_PALETTE } from "./presets.ts";

export interface ThemeControllerOptions {
  /** User-defined themes, offered beside the presets. */
  themes: ThemeBook;
  /** A theme id, or "auto" to follow the terminal's light/dark scheme. */
  setting: string;
  /** Called with the new setting whenever the user picks a theme. */
  onChange: ((setting: string) => void) | undefined;
  /** Strings carry their colour, so the owner must build its screen again. */
  rebuild: () => void;
  /** Report something the user should see, e.g. an unknown theme name. */
  notify: (message: string) => void;
}

/** Owns which theme is live: the setting, the terminal's scheme, and the picker. */
export class ThemeController {
  private overlay: OverlayHandle | null = null;
  private scheme: TerminalColorScheme = "dark";
  private setting: string;
  private readonly tui: TuiAltScreen;
  private readonly options: ThemeControllerOptions;

  constructor(tui: TuiAltScreen, options: ThemeControllerOptions) {
    this.tui = tui;
    this.options = options;
    this.setting = options.setting;
    this.restyle();
  }

  /** While the picker is open it owns the keyboard. */
  get pickerOpen(): boolean {
    return this.overlay !== null;
  }

  /** Start tracking the terminal's light/dark scheme, and read it once now. */
  async followTerminal(): Promise<void> {
    this.tui.onTerminalColorSchemeChange((scheme) => this.adoptScheme(scheme));
    this.tui.setTerminalColorSchemeNotifications(true);
    const reported = await this.tui.queryTerminalColors({ timeoutMs: 200 }).catch(() => ({}));
    if ("background" in reported && reported.background) {
      this.adoptScheme(schemeOfBackground(reported.background));
    }
  }

  showPicker(): void {
    if (this.overlay) {
      return;
    }
    const picker = createThemePicker(
      listThemes(this.options.themes),
      this.setting,
      (setting) => this.choose(setting),
      () => this.closePicker(),
    );
    this.overlay = this.tui.showOverlay(picker, { width: "60%", anchor: "center" });
    this.tui.requestRender();
  }

  /** Paint the live palette from the current setting and terminal scheme. */
  private restyle(): void {
    const id = resolveThemeId(this.setting, this.scheme);
    const entry = listThemes(this.options.themes).find((candidate) => candidate.id === id);
    if (!entry) {
      this.options.notify(`unknown theme "${id}"; using the default`);
    }
    applyPalette(entry?.palette ?? DOVO_PALETTE);
  }

  private adoptScheme(scheme: TerminalColorScheme): void {
    if (scheme === this.scheme) {
      return;
    }
    this.scheme = scheme;
    if (this.setting === AUTO_THEME) {
      this.restyle();
      this.options.rebuild();
    }
  }

  private closePicker(): void {
    this.overlay?.hide();
    this.overlay = null;
    this.tui.requestRender();
  }

  private choose(setting: string): void {
    this.closePicker();
    this.setting = setting;
    this.restyle();
    this.options.rebuild();
    this.options.onChange?.(setting);
  }
}

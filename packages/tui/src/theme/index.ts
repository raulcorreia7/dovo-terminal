import {
  getTerminalColorMode,
  type MarkdownTheme,
  parseColor,
  type SelectListTheme,
  styleText,
  type TerminalColorScheme,
} from "@earendil-works/pi-tui";
import { DEFAULT_DARK, DEFAULT_LIGHT, type Palette, type ThemeBook } from "./palette.ts";
import { DOVO_PALETTE, PRESETS } from "./presets.ts";

// The live palette. Every style below reads it at call time, so applying a
// theme restyles anything built afterwards; screens rebuild to pick it up.
// `t()` takes palette VALUES (hex strings); import `colors` for named references.
export const colors: Palette = { ...DOVO_PALETTE };

export interface ThemeEntry {
  readonly id: string;
  readonly label: string;
  readonly palette: Palette;
}

/** Presets first, then the user's own; a user theme replaces a preset of the same id. */
export function listThemes(custom: ThemeBook): ThemeEntry[] {
  const presets = Object.entries(PRESETS)
    .filter(([id]) => !(id in custom))
    .map(([id, preset]) => ({ id, label: preset.label, palette: preset.palette }));
  const own = Object.entries(custom).map(([id, palette]) => ({ id, label: id, palette }));

  return [...presets, ...own];
}

/** Every theme as a lookup, the base set a user theme file can `extends`. */
export function themeBook(custom: ThemeBook): ThemeBook {
  return Object.fromEntries(listThemes(custom).map((entry) => [entry.id, entry.palette]));
}

/** "auto" (or nothing) follows the terminal's light/dark scheme. */
export function resolveThemeId(requested: string | undefined, scheme: TerminalColorScheme): string {
  if (requested && requested !== "auto") {
    return requested;
  }
  if (scheme === "light") {
    return DEFAULT_LIGHT;
  }

  return DEFAULT_DARK;
}

/** Light or dark, judged by the relative luminance of the terminal background. */
export function schemeOfBackground(rgb: { r: number; g: number; b: number }): TerminalColorScheme {
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  if (luminance > 128) {
    return "light";
  }

  return "dark";
}

export function applyPalette(palette: Palette): void {
  Object.assign(colors, palette);
}

// NO_COLOR (https://no-color.org): drop colour, keep bold/italic/underline.
const noColor = (process.env["NO_COLOR"] ?? "") !== "";

type StyleAttrs = Partial<{
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}>;

export function t(text: string, color?: string, attrs: StyleAttrs = {}): string {
  if (!color) {
    return text;
  }
  const style = noColor ? attrs : { fg: parseColor(color), ...attrs };

  return styleText(text, style, getTerminalColorMode());
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => t(s, colors.accent, { bold: true }),
  link: (s) => t(s, colors.user, { underline: true }),
  linkUrl: (s) => t(s, colors.dim),
  code: (s) => t(s, colors.code),
  codeBlock: (s) => t(s, colors.code),
  codeBlockBorder: (s) => t(s, colors.border),
  quote: (s) => t(s, colors.muted, { italic: true }),
  quoteBorder: (s) => t(s, colors.border),
  hr: (s) => t(s, colors.border),
  listBullet: (s) => t(s, colors.accent),
  bold: (s) => t(s, colors.text, { bold: true }),
  italic: (s) => t(s, colors.text, { italic: true }),
  strikethrough: (s) => t(s, colors.muted, { strikethrough: true }),
  underline: (s) => t(s, colors.text, { underline: true }),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => t(s, colors.accent),
  selectedText: (s) => t(s, colors.text, { bold: true }),
  description: (s) => t(s, colors.muted),
  scrollInfo: (s) => t(s, colors.dim),
  noMatch: (s) => t(s, colors.dim, { italic: true }),
};

export const editorBorder = (s: string) => t(s, colors.border);

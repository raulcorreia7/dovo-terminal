import {
  getTerminalColorMode,
  type MarkdownTheme,
  parseColor,
  type SelectListTheme,
  styleText,
} from "@earendil-works/pi-tui";

// Single palette for the whole app. `t()` takes palette VALUES (hex strings);
// import `colors` for named references. Markdown/select-list themes are plain
// style functions by pi-tui design.
export const colors = {
  text: "#e6e1d8",
  muted: "#8b8578",
  dim: "#6a655b",
  accent: "#e8a04c",
  user: "#7fb4d3",
  ok: "#93b77a",
  warn: "#e8c05c",
  error: "#d46a5c",
  border: "#4a463f",
  code: "#c9b98a",
};

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
  return styleText(text, { fg: parseColor(color), ...attrs }, getTerminalColorMode());
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

// A palette is the whole vocabulary of the UI's colour: ten named roles, each a
// 6-digit hex string. Presets, user theme files and the live theme all share it.
import { z } from "zod";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/u, "expected a #rrggbb colour");

export const PaletteSchema = z.strictObject({
  text: Hex,
  muted: Hex,
  dim: Hex,
  accent: Hex,
  user: Hex,
  ok: Hex,
  warn: Hex,
  error: Hex,
  border: Hex,
  code: Hex,
});
export type Palette = z.infer<typeof PaletteSchema>;

/**
 * A theme file on disk. `extends` names a preset or another theme to start
 * from; `colors` overrides only the roles it lists. Unknown keys are rejected
 * so a typo in a role name is an error, not a silently ignored colour.
 */
export const ThemeFileSchema = z.strictObject({
  extends: z.string().optional(),
  colors: PaletteSchema.partial(),
});
export type ThemeFile = z.infer<typeof ThemeFileSchema>;

/** A named collection of palettes: the presets plus whatever the user added. */
export type ThemeBook = Readonly<Record<string, Palette>>;

export const DEFAULT_DARK = "dovo";
export const DEFAULT_LIGHT = "dovo-light";

/** Merge a theme file over its base. Returns an error text when the base is unknown. */
export function buildPalette(file: ThemeFile, book: ThemeBook): Palette | string {
  const baseName = file.extends ?? DEFAULT_DARK;
  const base = book[baseName];
  if (!base) {
    return `extends unknown theme "${baseName}"`;
  }

  const overrides = Object.entries(file.colors).filter(([, colour]) => colour !== undefined);

  return PaletteSchema.parse({ ...base, ...Object.fromEntries(overrides) });
}

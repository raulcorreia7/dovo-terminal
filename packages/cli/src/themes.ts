import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import { themeBook } from "@dovo-terminal/tui/theme/index.ts";
import { buildPalette, type ThemeBook, ThemeFileSchema } from "@dovo-terminal/tui/theme/palette.ts";

export interface LoadedThemes {
  themes: ThemeBook;
  /** One line per theme file that could not be used, for the status bar. */
  problems: string[];
}

/**
 * Read every `*.json` theme file in `dir`, in name order. A file may extend a
 * preset or a theme loaded before it. A missing directory is not an error; a
 * broken file is skipped and reported, never fatal.
 */
export function loadUserThemes(dir: string): LoadedThemes {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return { themes: {}, problems: [] };
  }

  let themes: ThemeBook = {};
  const problems: string[] = [];
  for (const name of names) {
    try {
      const file = ThemeFileSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      const palette = buildPalette(file, themeBook(themes));
      if (typeof palette === "string") {
        problems.push(`theme ${name}: ${palette}`);
        continue;
      }
      themes = { ...themes, [basename(name, ".json")]: palette };
    } catch (error) {
      problems.push(`theme ${name}: ${errorMessage(error)}`);
    }
  }

  return { themes, problems };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listThemes, resolveThemeId, schemeOfBackground, themeBook } from "../src/theme/index.ts";
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  type Palette,
  PaletteSchema,
  ThemeFileSchema,
} from "../src/theme/palette.ts";
import { PRESETS } from "../src/theme/presets.ts";

const UNKNOWN_BASE = /unknown theme/u;

function presetPalette(id: string): Palette {
  const preset = PRESETS[id];
  assert.ok(preset, `no preset ${id}`);

  return preset.palette;
}

describe("presets", () => {
  it("every preset is a complete, valid palette", () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      assert.ok(PaletteSchema.safeParse(preset.palette).success, id);
    }
  });

  it("has a default for each terminal scheme", () => {
    assert.equal(PRESETS[DEFAULT_DARK]?.scheme, "dark");
    assert.equal(PRESETS[DEFAULT_LIGHT]?.scheme, "light");
  });

  it("keeps the main text readable against its own border (contrast sanity)", () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      assert.notEqual(preset.palette.text, preset.palette.border, id);
    }
  });
});

describe("theme choice", () => {
  it("auto follows the terminal scheme", () => {
    assert.equal(resolveThemeId("auto", "dark"), DEFAULT_DARK);
    assert.equal(resolveThemeId(undefined, "light"), DEFAULT_LIGHT);
  });

  it("a named theme wins over the scheme", () => {
    assert.equal(resolveThemeId("nord", "light"), "nord");
  });

  it("judges a terminal background by luminance", () => {
    assert.equal(schemeOfBackground({ r: 0, g: 0, b: 0 }), "dark");
    assert.equal(schemeOfBackground({ r: 255, g: 255, b: 255 }), "light");
  });

  it("a user theme replaces a preset with the same id", () => {
    const nord = listThemes({ nord: presetPalette("dracula") }).filter(
      (entry) => entry.id === "nord",
    );

    assert.equal(nord.length, 1);
    assert.deepEqual(nord[0]?.palette, presetPalette("dracula"));
  });
});

describe("theme files", () => {
  const book = themeBook({});

  it("overrides only the roles it names", () => {
    const palette = buildPalette({ extends: "nord", colors: { accent: "#ff00ff" } }, book);
    assert.ok(typeof palette !== "string");
    assert.equal(palette.accent, "#ff00ff");
    assert.equal(palette.text, presetPalette("nord").text);
  });

  it("starts from the default when it extends nothing", () => {
    const palette = buildPalette({ colors: {} }, book);
    assert.deepEqual(palette, presetPalette(DEFAULT_DARK));
  });

  it("reports an unknown base", () => {
    assert.match(String(buildPalette({ extends: "nope", colors: {} }, book)), UNKNOWN_BASE);
  });

  it("rejects a misspelt role and a malformed colour", () => {
    assert.equal(ThemeFileSchema.safeParse({ colors: { acent: "#ffffff" } }).success, false);
    assert.equal(ThemeFileSchema.safeParse({ colors: { accent: "red" } }).success, false);
  });
});

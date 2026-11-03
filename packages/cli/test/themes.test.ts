import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadUserThemes } from "../src/themes.ts";

function themeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dovo-themes-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }

  return dir;
}

describe("loadUserThemes", () => {
  it("treats a missing directory as no themes", () => {
    assert.deepEqual(loadUserThemes(join(tmpdir(), "dovo-no-such-dir")), {
      themes: {},
      problems: [],
    });
  });

  it("loads a theme that extends a preset, named after its file", () => {
    const dir = themeDir({
      "mine.json": JSON.stringify({ extends: "nord", colors: { accent: "#123456" } }),
    });
    const { themes, problems } = loadUserThemes(dir);

    assert.deepEqual(problems, []);
    assert.equal(themes["mine"]?.accent, "#123456");
  });

  it("lets a later theme extend an earlier one", () => {
    const dir = themeDir({
      "a.json": JSON.stringify({ colors: { accent: "#111111" } }),
      "b.json": JSON.stringify({ extends: "a", colors: { ok: "#222222" } }),
    });
    const { themes } = loadUserThemes(dir);

    assert.equal(themes["b"]?.accent, "#111111");
    assert.equal(themes["b"]?.ok, "#222222");
  });

  it("skips and reports a broken file without losing the good ones", () => {
    const dir = themeDir({
      "bad.json": "{ not json",
      "good.json": JSON.stringify({ colors: {} }),
      "typo.json": JSON.stringify({ colors: { acent: "#ffffff" } }),
    });
    const { themes, problems } = loadUserThemes(dir);

    assert.deepEqual(Object.keys(themes), ["good"]);
    assert.equal(problems.length, 2);
  });
});

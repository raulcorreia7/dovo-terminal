import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig, saveConfig } from "../src/config.ts";

const original = process.env["DOVO_TUI_CONFIG"];
afterEach(() => {
  if (original === undefined) {
    delete process.env["DOVO_TUI_CONFIG"];
  } else {
    process.env["DOVO_TUI_CONFIG"] = original;
  }
});

function freshConfigPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "dovo-config-")), "config.json");
  process.env["DOVO_TUI_CONFIG"] = path;

  return path;
}

describe("config", () => {
  it("starts from defaults when there is no file, and leaves no backup", () => {
    const path = freshConfigPath();

    assert.equal(loadConfig().current, "local");
    assert.throws(() => statSync(`${path}.bak`));
  });

  it("keeps an unreadable file as .bak before anything can overwrite it", () => {
    const path = freshConfigPath();
    writeFileSync(path, '{ "current": "work", "runtimes": { broken');

    const loaded = loadConfig();
    saveConfig(loaded);

    assert.equal(loaded.current, "local");
    assert.equal(readFileSync(`${path}.bak`, "utf8"), '{ "current": "work", "runtimes": { broken');
  });

  it("tightens the permissions of a config that already existed", () => {
    const path = freshConfigPath();
    writeFileSync(path, "{}", { mode: 0o644 });

    saveConfig(loadConfig());

    assert.equal(statSync(path).mode.toString(8).slice(-3), "600");
  });
});

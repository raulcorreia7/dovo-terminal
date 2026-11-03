import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isListAction, keyFor, LIST_KEYS, pressed, shown } from "../src/keys.ts";

describe("keys", () => {
  it("uses the default unless overridden", () => {
    assert.equal(keyFor("new", {}), LIST_KEYS.new);
    assert.equal(keyFor("new", { new: "c" }), "c");
  });

  it("matches the bound key, and after a remap only the new one", () => {
    assert.equal(pressed("n", "new", {}), true);
    assert.equal(pressed("c", "new", {}), false);
    assert.equal(pressed("c", "new", { new: "c" }), true);
    assert.equal(pressed("n", "new", { new: "c" }), false);
  });

  it("never matches a key id it does not know, instead of throwing", () => {
    assert.equal(pressed("n", "new", { new: "not-a-key" }), false);
  });

  it("knows which names are actions", () => {
    assert.equal(isListAction("archive"), true);
    assert.equal(isListAction("quit"), false);
  });

  it("writes arrows and capitals the way people read them", () => {
    assert.equal(shown("right"), "→");
    assert.equal(shown("shift+d"), "D");
    assert.equal(shown("n"), "n");
  });
});

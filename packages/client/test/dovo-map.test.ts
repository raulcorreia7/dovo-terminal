import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { harnessLabel, toModelOptions } from "../src/dovo-map.ts";

describe("harnessLabel", () => {
  it("names the harnesses people know", () => {
    assert.equal(harnessLabel("opencode"), "OpenCode");
    assert.equal(harnessLabel("pi"), "Pi");
    assert.equal(harnessLabel("claude"), "Claude");
  });

  it("shows a harness it has not heard of under its own id", () => {
    assert.equal(harnessLabel("brand-new"), "brand-new");
  });
});

describe("toModelOptions", () => {
  it("takes bare ids", () => {
    assert.deepEqual(toModelOptions(["a", "b"]), [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ]);
  });

  it("takes objects that name themselves under any usual key", () => {
    assert.deepEqual(
      toModelOptions([
        { id: "m1", label: "Model One" },
        { value: "m2", name: "Model Two" },
        { name: "m3" },
      ]),
      [
        { id: "m1", label: "Model One" },
        { id: "m2", label: "Model Two" },
        { id: "m3", label: "m3" },
      ],
    );
  });

  it("drops entries that name nothing instead of failing the catalog", () => {
    assert.deepEqual(toModelOptions(["", {}, { id: "ok" }]), [{ id: "ok", label: "ok" }]);
  });
});

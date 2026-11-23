/**
 * Tests for `@svendowideit/vim`.
 *
 * The Vim server interactions are exercised against a real server in the
 * extension's smoke workflow. These tests cover the pure edit planner, the
 * diff, the hash and the model surface so an ambiguous edit or a renamed
 * method is caught without a running Vim.
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  applyEdits,
  deriveServerName,
  EXT_TYPE,
  EXT_VERSION,
  model,
  sha256Hex,
  unifiedDiff,
} from "./vim.ts";

Deno.test("deriveServerName makes a stable server from the cwd", () => {
  assertEquals(
    deriveServerName("swamp-vim", "/home/sven/src/swamp-project"),
    "swamp-vim-swamp-project",
  );
  assertEquals(
    deriveServerName("swamp-vim", "C:\\Users\\sven\\project"),
    "swamp-vim-project",
  );
  assertEquals(deriveServerName("swamp-vim", "/"), "swamp-vim-vim");
});

Deno.test("applyEdits replaces exactly one old string", () => {
  assertEquals(
    applyEdits(["alpha", "beta", "gamma"], [{ old: "beta", new: "BETA" }]),
    ["alpha", "BETA", "gamma"],
  );
  assertEquals(
    applyEdits(["one", "two"], [{ old: "one\ntwo", new: "three" }]),
    ["three"],
  );
});

Deno.test("applyEdits rejects a missing or ambiguous old string", () => {
  assertThrows(
    () => applyEdits(["alpha"], [{ old: "missing", new: "x" }]),
    Error,
    "old text not found",
  );
  assertThrows(
    () => applyEdits(["a", "a"], [{ old: "a", new: "b" }]),
    Error,
    "occurs 2 times",
  );
  assertThrows(
    () => applyEdits(["alpha"], [{ old: "", new: "x" }]),
    Error,
    "empty old string",
  );
});

Deno.test("applyEdits replaces a 1-indexed line range", () => {
  assertEquals(
    applyEdits(["a", "b", "c", "d"], [{
      startLine: 2,
      endLine: 3,
      lines: ["B", "C", "extra"],
    }]),
    ["a", "B", "C", "extra", "d"],
  );
  assertEquals(
    applyEdits(["a", "b", "c"], [{ startLine: 2, endLine: 2, lines: [] }]),
    ["a", "c"],
  );
});

Deno.test("applyEdits replaces the whole buffer with setLines", () => {
  assertEquals(
    applyEdits(["old"], [{ setLines: ["new", "buffer"] }]),
    ["new", "buffer"],
  );
  assertEquals(applyEdits(["old"], [{ setLines: [] }]), [""]);
});

Deno.test("applyEdits rejects an out-of-range line edit", () => {
  assertThrows(
    () => applyEdits(["a"], [{ startLine: 2, endLine: 2, lines: ["b"] }]),
    Error,
    "starts past the buffer",
  );
  assertThrows(
    () => applyEdits(["a"], [{ startLine: 1, endLine: 2, lines: ["b"] }]),
    Error,
    "ends past the buffer",
  );
});

Deno.test("unifiedDiff shows the changed line with context", () => {
  const diff = unifiedDiff(
    ["one", "two", "three"],
    ["one", "TWO", "three"],
    "f.txt",
  );
  assert(diff.includes("--- a/f.txt"));
  assert(diff.includes("+++ b/f.txt"));
  assert(diff.includes("-two"));
  assert(diff.includes("+TWO"));
  assert(diff.includes(" one"));
  assertEquals(unifiedDiff(["same"], ["same"], "f.txt"), "");
});

Deno.test("sha256Hex is the standard SHA-256 of the text", async () => {
  assertEquals(
    await sha256Hex("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("model exposes the Vim type and the phase-two methods", () => {
  assertEquals(model.type, EXT_TYPE);
  assertEquals(model.version, EXT_VERSION);
  assertEquals(model.type, "@svendowideit/vim-controller");
  const methods = Object.keys(model.methods).sort();
  for (
    const expected of [
      "annotate",
      "close",
      "command",
      "cursor",
      "diagnostics",
      "diff",
      "edit",
      "expr",
      "keys",
      "open",
      "otel-status",
      "read",
      "select",
      "servers",
      "status",
      "undo",
      "write",
    ]
  ) {
    assert(methods.includes(expected), `missing method ${expected}`);
  }
});

Deno.test("every Vim method has a description and an execute function", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    assert(
      typeof method.description === "string" && method.description.length > 20,
      `${name} has no meaningful description`,
    );
    assertEquals(typeof method.execute, "function");
  }
});
